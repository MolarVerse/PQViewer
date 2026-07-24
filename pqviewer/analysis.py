"""Typed analysis routes backed by PQAnalysis."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import asdict
import math
from pathlib import Path
from typing import Any, Literal, Mapping

import numpy as np
from anyio import to_process
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .data import FrameData, FrameKey, PQTrajectoryDataset
from .sources import RunDataset, open_run_dataset


MAX_POSITION_ATOMS = 32
MAX_POSITION_FRAMES = 512
MAX_RDF_SELECTION_ATOMS = 4096
MAX_RDF_FRAMES = 10_000
MAX_RDF_BINS = 4096
MAX_RDF_PAIR_EVALUATIONS = 50_000_000
MAX_GENERIC_RDF_ATOM_FRAMES = 5_000_000
ANALYSIS_POLL_SECONDS = 0.05
STALE_DATASET_DETAIL = "Trajectory changed. Reload the manifest."


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PositionsRequest(StrictModel):
    dataset_generation: str = Field(min_length=1, max_length=256)
    atom_indices: list[int] = Field(
        min_length=1,
        max_length=MAX_POSITION_ATOMS,
    )
    frame_indices: list[int] = Field(
        min_length=1,
        max_length=MAX_POSITION_FRAMES,
    )
    coordinates: Literal["source", "unwrapped"] = "unwrapped"

    @field_validator("atom_indices", "frame_indices")
    @classmethod
    def unique_indices(cls, values: list[int]) -> list[int]:
        if any(value < 0 for value in values):
            raise ValueError("indices must be 0-based")
        if len(set(values)) != len(values):
            raise ValueError("indices must be unique")
        return values


class FrameKeyResult(StrictModel):
    source_id: str
    source_index: int
    segment_index: int = 0
    step: int | None = None
    time: float | None = None
    time_unit: str | None = None


class PositionFrameResult(StrictModel):
    index: int
    key: FrameKeyResult | None
    positions: list[list[float]]
    step: int | None
    time: float | None
    time_unit: str | None


class PositionsResult(StrictModel):
    schema_version: Literal[1] = 1
    dataset_generation: str
    atom_indices: list[int]
    unit: str
    frames: list[PositionFrameResult]


class RDFRequest(StrictModel):
    dataset_generation: str = Field(min_length=1, max_length=256)
    reference_indices: list[int] = Field(
        min_length=1,
        max_length=MAX_RDF_SELECTION_ATOMS,
    )
    target_indices: list[int] = Field(
        min_length=1,
        max_length=MAX_RDF_SELECTION_ATOMS,
    )
    frame_start: int = Field(default=0, ge=0)
    frame_stop: int | None = Field(default=None, ge=1)
    frame_step: int = Field(default=1, ge=1)
    n_bins: int = Field(default=200, ge=1, le=MAX_RDF_BINS)
    r_max: float | None = Field(default=None, gt=0, le=1_000_000)

    @field_validator("reference_indices", "target_indices")
    @classmethod
    def zero_based_indices(cls, values: list[int]) -> list[int]:
        if any(value < 0 for value in values):
            raise ValueError("indices must be 0-based")
        return values

    @field_validator("r_max")
    @classmethod
    def finite_radius(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("r_max must be finite")
        return value


class RDFFrameRange(StrictModel):
    start: int
    stop: int
    step: int
    count: int
    first_key: FrameKeyResult
    last_key: FrameKeyResult


class RDFParameters(StrictModel):
    r_min: Literal[0.0] = 0.0
    r_max: float
    delta_r: float
    n_bins: int


class RDFUnits(StrictModel):
    radius: Literal["angstrom"] = "angstrom"
    g_r: Literal["dimensionless"] = "dimensionless"
    coordination: Literal["atoms"] = "atoms"


class RDFSelections(StrictModel):
    reference_indices: list[int]
    target_indices: list[int]


class RDFResult(StrictModel):
    schema_version: Literal[1] = 1
    dataset_generation: str
    selections: RDFSelections
    reference_count: int
    target_count: int
    frame_range: RDFFrameRange
    parameters: RDFParameters
    units: RDFUnits
    radius_centers: list[float]
    g_r: list[float]
    coordination_radius: list[float]
    coordination: list[float]
    pqanalysis_version: str
    elapsed_seconds: float = Field(ge=0)


class AnalysisInputError(ValueError):
    """Raised for a source that cannot support the requested analysis."""


class AnalysisSourceChangedError(RuntimeError):
    """Raised when source files change during an analysis."""


def register_analysis_routes(application: FastAPI) -> None:
    """Add bounded positions and RDF endpoints."""

    @application.post("/api/positions", response_model=PositionsResult)
    def positions(payload: PositionsRequest) -> dict[str, Any]:
        with application.state.dataset_lock:
            _require_generation(application, payload.dataset_generation)
            dataset = application.state.dataset
            manifest = dataset.manifest()
            _validate_requested_indices(
                payload.atom_indices,
                int(manifest.get("topology", {}).get("atom_count", 0)),
                "atom",
            )
            _validate_requested_indices(
                payload.frame_indices,
                int(manifest.get("frame_count", 0)),
                "frame",
            )
            frames = [
                _position_frame(dataset, index, payload.coordinates)
                for index in payload.frame_indices
            ]
            units = {frame.pop("_unit") for frame in frames}
        if len(units) != 1:
            raise HTTPException(
                status_code=422,
                detail="Selected frames use different position units.",
            )
        return {
            "schema_version": 1,
            "dataset_generation": payload.dataset_generation,
            "atom_indices": payload.atom_indices,
            "unit": units.pop(),
            "frames": [
                {
                    **frame,
                    "positions": np.asarray(frame["positions"])[
                        payload.atom_indices
                    ].tolist(),
                }
                for frame in frames
            ],
        }

    @application.post("/api/analysis/rdf", response_model=RDFResult)
    async def rdf(payload: RDFRequest, request: Request) -> dict[str, Any]:
        with application.state.dataset_lock:
            _require_generation(application, payload.dataset_generation)
            prepared = _prepare_rdf_request(
                application.state.dataset,
                payload,
            )

        try:
            result = await _run_rdf_process(
                application,
                request,
                payload.dataset_generation,
                prepared["descriptor"],
                prepared["worker_request"],
            )
        except AnalysisSourceChangedError as error:
            raise HTTPException(
                status_code=409,
                detail=STALE_DATASET_DETAIL,
            ) from error
        except AnalysisInputError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

        with application.state.dataset_lock:
            _require_generation(application, payload.dataset_generation)
        return {
            **result,
            "dataset_generation": payload.dataset_generation,
        }


def _position_frame(
    dataset: Any,
    frame_index: int,
    coordinates: Literal["source", "unwrapped"],
) -> dict[str, Any]:
    try:
        frame = dataset.get_frame(frame_index, coordinates=coordinates)
    except IndexError as error:
        raise HTTPException(status_code=404, detail="Frame not found.") from error
    positions = (
        frame.unwrapped_positions if coordinates == "unwrapped" else frame.positions
    )
    if positions is None:
        raise HTTPException(
            status_code=422,
            detail="Unwrapped positions are unavailable.",
        )
    array = np.asarray(positions, dtype=np.float64)
    if array.ndim != 2 or array.shape[1] != 3:
        raise HTTPException(
            status_code=422,
            detail="Frame positions have an invalid shape.",
        )
    key = _frame_key_dict(frame.frame_key)
    step = key.get("step") if key is not None else _integer_scalar(frame, "step")
    time = key.get("time") if key is not None else _number_scalar(frame, "time")
    time_unit = key.get("time_unit") if key is not None else frame.units.get("time")
    unit_key = "unwrapped_positions" if coordinates == "unwrapped" else "positions"
    return {
        "index": frame_index,
        "key": key,
        "positions": array,
        "step": step,
        "time": time,
        "time_unit": time_unit,
        "_unit": frame.units.get(unit_key)
        or frame.units.get("positions")
        or "angstrom",
    }


def _prepare_rdf_request(
    dataset: Any,
    payload: RDFRequest,
) -> dict[str, Any]:
    manifest = dataset.manifest()
    frame_count = int(manifest.get("frame_count", 0))
    atom_count = int(manifest.get("topology", {}).get("atom_count", 0))
    if frame_count < 1:
        raise HTTPException(status_code=422, detail="The trajectory has no frames.")
    reference_indices = sorted(set(payload.reference_indices))
    target_indices = sorted(set(payload.target_indices))
    _validate_requested_indices(reference_indices, atom_count, "reference atom")
    _validate_requested_indices(target_indices, atom_count, "target atom")

    stop = payload.frame_stop if payload.frame_stop is not None else frame_count
    if stop > frame_count:
        raise HTTPException(
            status_code=422,
            detail=f"frame_stop must not exceed {frame_count}.",
        )
    if payload.frame_start >= stop:
        raise HTTPException(
            status_code=422,
            detail="frame_start must be smaller than frame_stop.",
        )
    frame_indices = range(payload.frame_start, stop, payload.frame_step)
    selected_frames = len(frame_indices)
    if selected_frames > MAX_RDF_FRAMES:
        raise HTTPException(
            status_code=422,
            detail=f"RDF is limited to {MAX_RDF_FRAMES:,} frames.",
        )
    evaluations = selected_frames * len(reference_indices) * len(target_indices)
    if evaluations > MAX_RDF_PAIR_EVALUATIONS:
        raise HTTPException(
            status_code=422,
            detail=("RDF selection is too large. Reduce frames or selected atoms."),
        )

    descriptor = _source_descriptor(dataset)
    first = dataset.get_frame(frame_indices[0])
    last = dataset.get_frame(frame_indices[-1])
    first_key = _required_frame_key(first)
    last_key = _required_frame_key(last)
    descriptor["first_key"] = first_key
    descriptor["last_key"] = last_key
    descriptor["native"] = _can_use_native_reader(
        dataset,
        payload.frame_start,
        stop,
        payload.frame_step,
    )
    if (
        not descriptor["native"]
        and selected_frames * atom_count > MAX_GENERIC_RDF_ATOM_FRAMES
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                "RDF trajectory is too large to reconstruct. "
                "Reduce the selected frame range."
            ),
        )

    return {
        "descriptor": descriptor,
        "worker_request": {
            "reference_indices": reference_indices,
            "target_indices": target_indices,
            "frame_start": payload.frame_start,
            "frame_stop": stop,
            "frame_step": payload.frame_step,
            "frame_count": selected_frames,
            "n_bins": payload.n_bins,
            "r_max": payload.r_max,
        },
    }


def _source_descriptor(dataset: Any) -> dict[str, Any]:
    if not isinstance(dataset, RunDataset):
        raise HTTPException(
            status_code=422,
            detail="RDF requires a file-backed trajectory.",
        )
    source_value = dataset.provenance.get("path")
    if not source_value and len(dataset.segments) == 1:
        segment = dataset.segments[0]
        source_value = segment.input_path or segment.path
    if not source_value:
        raise HTTPException(
            status_code=422,
            detail="RDF requires a file-backed trajectory.",
        )
    source_path = Path(source_value).expanduser().resolve()
    paths: set[Path] = set()
    for segment in dataset.segments:
        if segment.path is not None:
            paths.add(segment.path)
        if segment.input_path is not None:
            paths.add(segment.input_path)
        paths.update((segment.files or {}).values())
    if source_path.is_file():
        paths.add(source_path)
    return {
        "source": str(source_path),
        "frame_slice": {
            "start": dataset.frame_slice.start,
            "stop": dataset.frame_slice.stop,
            "step": dataset.frame_slice.step,
        },
        "expected_frame_count": dataset.frame_count,
        "signatures": [
            _file_signature(path)
            for path in sorted(paths, key=lambda value: str(value))
            if path.is_file()
        ],
        "native_path": (
            str(dataset.segments[0].path)
            if len(dataset.segments) == 1 and dataset.segments[0].path is not None
            else None
        ),
    }


def _can_use_native_reader(
    dataset: Any,
    frame_start: int,
    frame_stop: int,
    frame_step: int,
) -> bool:
    if not isinstance(dataset, RunDataset) or len(dataset.segments) != 1:
        return False
    segment = dataset.segments[0]
    source = segment.source
    return (
        isinstance(source, PQTrajectoryDataset)
        and segment.kind.startswith("pq-")
        and str(source.traj_format.value).lower() == "xyz"
        and str(source.md_format.value).lower() == "pq"
        and dataset.frame_slice.indices(source.frame_count)
        == (0, source.frame_count, 1)
        and frame_start == 0
        and frame_stop == dataset.frame_count
        and frame_step == 1
    )


async def _run_rdf_process(
    application: FastAPI,
    request: Request,
    generation: str,
    descriptor: Mapping[str, Any],
    worker_request: Mapping[str, Any],
) -> dict[str, Any]:
    task = asyncio.create_task(
        to_process.run_sync(
            _rdf_worker,
            dict(descriptor),
            dict(worker_request),
            cancellable=True,
        )
    )
    try:
        while not task.done():
            if await request.is_disconnected():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
                raise HTTPException(status_code=499, detail="Analysis cancelled.")
            with application.state.dataset_lock:
                if generation != application.state.dataset_generation:
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
                    raise HTTPException(
                        status_code=409,
                        detail=STALE_DATASET_DETAIL,
                    )
            await asyncio.sleep(ANALYSIS_POLL_SECONDS)
        return await task
    finally:
        if not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


def _rdf_worker(
    descriptor: dict[str, Any],
    request: dict[str, Any],
) -> dict[str, Any]:
    from PQAnalysis import __version__ as pqanalysis_version
    from PQAnalysis.analysis import RDF

    _verify_signatures(descriptor["signatures"])
    try:
        trajectory = (
            _native_trajectory(descriptor)
            if descriptor["native"]
            else _generic_trajectory(descriptor, request)
        )
        reference_indices = np.asarray(
            sorted(set(request["reference_indices"])),
            dtype=np.int64,
        )
        target_indices = np.asarray(
            sorted(set(request["target_indices"])),
            dtype=np.int64,
        )
        analysis = RDF(
            trajectory,
            reference_indices,
            target_indices,
            n_bins=request["n_bins"],
            r_max=request["r_max"],
            r_min=0.0,
        )
        centers, g_r, coordination, _, _ = analysis.run()
    except AnalysisSourceChangedError:
        raise
    except Exception as error:
        raise AnalysisInputError(f"RDF could not be calculated: {error}") from error
    _verify_signatures(descriptor["signatures"])

    delta_r = float(analysis.delta_r)
    return {
        "schema_version": 1,
        "selections": {
            "reference_indices": reference_indices.tolist(),
            "target_indices": target_indices.tolist(),
        },
        "reference_count": len(reference_indices),
        "target_count": len(target_indices),
        "frame_range": {
            "start": request["frame_start"],
            "stop": request["frame_stop"],
            "step": request["frame_step"],
            "count": request["frame_count"],
            "first_key": descriptor["first_key"],
            "last_key": descriptor["last_key"],
        },
        "parameters": {
            "r_min": 0.0,
            "r_max": float(analysis.r_max),
            "delta_r": delta_r,
            "n_bins": int(analysis.n_bins),
        },
        "units": {
            "radius": "angstrom",
            "g_r": "dimensionless",
            "coordination": "atoms",
        },
        "radius_centers": _finite_list(centers, "g(r) radii"),
        "g_r": _finite_list(g_r, "g(r)"),
        "coordination_radius": _finite_list(
            np.asarray(centers) + delta_r / 2.0,
            "coordination radii",
        ),
        "coordination": _finite_list(coordination, "coordination"),
        "pqanalysis_version": str(pqanalysis_version),
        "elapsed_seconds": max(0.0, float(analysis.elapsed_time)),
    }


def _native_trajectory(descriptor: Mapping[str, Any]) -> Any:
    from PQAnalysis.io import TrajectoryReader

    path = descriptor.get("native_path")
    if not path:
        raise AnalysisInputError("RDF source is unavailable.")
    reader = TrajectoryReader(str(path), md_format="PQ")
    cells = reader.cells
    if len(cells) != descriptor["expected_frame_count"]:
        raise AnalysisSourceChangedError(STALE_DATASET_DETAIL)
    if not cells or any(cell.is_vacuum for cell in cells):
        raise AnalysisInputError("RDF requires fully periodic frames.")
    return reader


def _generic_trajectory(
    descriptor: Mapping[str, Any],
    request: Mapping[str, Any],
) -> Any:
    from PQAnalysis.atomic_system import AtomicSystem
    from PQAnalysis.core import Atom, Cell
    from PQAnalysis.traj import Trajectory

    slice_value = descriptor["frame_slice"]
    dataset = open_run_dataset(
        descriptor["source"],
        frame_slice=slice(
            slice_value["start"],
            slice_value["stop"],
            slice_value["step"],
        ),
    )
    if dataset.frame_count != descriptor["expected_frame_count"]:
        raise AnalysisSourceChangedError(STALE_DATASET_DETAIL)
    manifest = dataset.manifest()
    symbols = list(manifest.get("topology", {}).get("symbols", []))
    if not symbols:
        raise AnalysisInputError("RDF source has no atom topology.")
    atoms = [Atom(symbol) for symbol in symbols]
    frames = []
    for index in range(
        request["frame_start"],
        request["frame_stop"],
        request["frame_step"],
    ):
        frame = dataset.get_frame(index)
        if not all(frame.pbc):
            raise AnalysisInputError("RDF requires fully periodic frames.")
        matrix = np.asarray(
            frame.periodic_cell if frame.periodic_cell is not None else frame.cell,
            dtype=np.float64,
        )
        if matrix.shape != (3, 3) or not np.all(np.isfinite(matrix)):
            raise AnalysisInputError("RDF frame cell is invalid.")
        cell = Cell.init_from_box_matrix(matrix.T)
        if cell.is_vacuum or not math.isfinite(float(cell.volume)):
            raise AnalysisInputError("RDF requires fully periodic frames.")
        frames.append(
            AtomicSystem(
                atoms=atoms,
                pos=np.asarray(frame.positions, dtype=np.float64),
                cell=cell,
            )
        )
    return Trajectory(frames)


def _require_generation(application: FastAPI, generation: str) -> None:
    if generation != application.state.dataset_generation:
        raise HTTPException(status_code=409, detail=STALE_DATASET_DETAIL)


def _validate_requested_indices(
    values: list[int],
    count: int,
    label: str,
) -> None:
    if any(value < 0 or value >= count for value in values):
        raise HTTPException(
            status_code=422,
            detail=f"{label.capitalize()} index is outside 0..{count - 1}.",
        )


def _required_frame_key(frame: FrameData) -> dict[str, Any]:
    value = _frame_key_dict(frame.frame_key)
    if value is None:
        raise HTTPException(
            status_code=422,
            detail="RDF requires stable frame identity.",
        )
    return value


def _frame_key_dict(frame_key: FrameKey | None) -> dict[str, Any] | None:
    return asdict(frame_key) if frame_key is not None else None


def _integer_scalar(frame: FrameData, key: str) -> int | None:
    value = frame.scalars.get(key)
    if isinstance(value, (int, np.integer)) and not isinstance(
        value,
        (bool, np.bool_),
    ):
        return int(value)
    return None


def _number_scalar(frame: FrameData, key: str) -> float | None:
    value = frame.scalars.get(key)
    if isinstance(value, (int, float, np.integer, np.floating)) and not isinstance(
        value,
        (bool, np.bool_),
    ):
        return float(value)
    return None


def _file_signature(path: Path) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    stat = resolved.stat()
    return {
        "path": str(resolved),
        "device": stat.st_dev,
        "inode": stat.st_ino,
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
    }


def _verify_signatures(signatures: list[Mapping[str, Any]]) -> None:
    for expected in signatures:
        try:
            actual = _file_signature(Path(expected["path"]))
        except OSError as error:
            raise AnalysisSourceChangedError(STALE_DATASET_DETAIL) from error
        if actual != expected:
            raise AnalysisSourceChangedError(STALE_DATASET_DETAIL)


def _finite_list(values: Any, label: str) -> list[float]:
    array = np.asarray(values, dtype=np.float64)
    if array.ndim != 1 or not np.all(np.isfinite(array)):
        raise AnalysisInputError(f"{label} contains invalid values.")
    return array.tolist()
