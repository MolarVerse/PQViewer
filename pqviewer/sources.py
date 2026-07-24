"""Unified indexed sources for PQ runs and external structures."""

from __future__ import annotations

from bisect import bisect_right
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
from threading import RLock
from typing import Any, Literal, Protocol, runtime_checkable

import numpy as np

from PQAnalysis.core import Cell
from PQAnalysis.io import MoldescriptorReader, PQInputFileReader, read_restart_file

from .data import FrameData, FrameKey, PQTrajectoryDataset
from .periodic import (
    apply_image_shifts,
    checked_int32,
    reverse_unwrap_image_step,
    unwrap_image_step,
)


CoordinateMode = Literal["source", "unwrapped"]

_PQ_FILE_KEYS = {
    "start_file",
    "rpmd_start_file",
    "file_prefix",
    "traj_file",
    "vel_file",
    "force_file",
    "charge_file",
    "energy_file",
    "info_file",
    "restart_file",
    "rpmd_traj_file",
    "rpmd_vel_file",
    "rpmd_force_file",
    "rpmd_charge_file",
    "rpmd_energy_file",
    "rpmd_restart_file",
}


@runtime_checkable
class IndexedFrameSource(Protocol):
    """Small contract required by the viewer transport."""

    name: str

    @property
    def frame_count(self) -> int:
        """Return the number of complete frames."""

    def manifest(self) -> dict[str, Any]:
        """Describe topology, properties, and frame series."""

    def get_frame(self, index: int) -> FrameData:
        """Read one source frame."""

    def refresh(self) -> int:
        """Refresh a growing source and return the number of added frames."""


@dataclass(frozen=True, slots=True)
class SourceSegment:
    """One indexed segment in a run."""

    source_id: str
    source: IndexedFrameSource
    kind: str
    path: Path | None = None
    input_path: Path | None = None
    files: Mapping[str, Path] | None = None


@dataclass(frozen=True, slots=True)
class _UnwrapAnchor:
    positions: np.ndarray
    cell: np.ndarray
    pbc: tuple[bool, bool, bool]
    shifts: np.ndarray


class RunDataset:
    """A lazy, sliced view over one or more indexed source segments."""

    UNWRAP_CACHE_SIZE = 32
    UNWRAP_CACHE_BYTES = 32 * 1024**2

    def __init__(
        self,
        segments: Sequence[SourceSegment],
        *,
        name: str | None = None,
        frame_slice: slice | None = None,
        provenance: Mapping[str, Any] | None = None,
    ) -> None:
        if not segments:
            raise ValueError("a run dataset requires at least one source segment")
        self.segments = tuple(segments)
        self.name = name or self.segments[0].source.name
        self.frame_slice = frame_slice or slice(None)
        if self.frame_slice.step == 0:
            raise ValueError("frame slice step cannot be zero")
        self.provenance = dict(provenance or {})
        self._offsets: tuple[int, ...] = ()
        self._view_range = range(0)
        self._unwrapped_cache: OrderedDict[int, _UnwrapAnchor] = OrderedDict()
        self._unwrapped_cache_bytes = 0
        self._unwrapped_lock = RLock()
        self._rebuild_index()
        self._validate_topologies()

    @property
    def frame_count(self) -> int:
        return len(self._view_range)

    @property
    def path(self) -> Path | None:
        """Return the single source path for compatibility."""
        return self.segments[0].path if len(self.segments) == 1 else None

    def manifest(self) -> dict[str, Any]:
        manifests = [segment.source.manifest() for segment in self.segments]
        self._rebuild_index()
        result = dict(manifests[0])
        result["name"] = self.name
        result["frame_count"] = self.frame_count
        result["coordinate_modes"] = ["source", "unwrapped"]
        result["properties"] = self._combined_properties(manifests)
        result["series"] = self._combined_series(manifests)
        result["companion_files"] = self._combined_companions(manifests)
        result["source"] = {
            **self.provenance,
            "slice": _slice_manifest(self.frame_slice),
            "segments": [
                {
                    "source_id": segment.source_id,
                    "kind": segment.kind,
                    "path": str(segment.path) if segment.path is not None else None,
                    "input": (
                        str(segment.input_path)
                        if segment.input_path is not None
                        else None
                    ),
                    "frame_count": segment.source.frame_count,
                    "files": {
                        key: str(value)
                        for key, value in (segment.files or {}).items()
                    },
                }
                for segment in self.segments
            ],
        }
        return result

    def get_frame(
        self,
        index: int,
        *,
        coordinates: CoordinateMode = "source",
    ) -> FrameData:
        if coordinates not in {"source", "unwrapped"}:
            raise ValueError("coordinates must be source or unwrapped")
        physical_index = self._physical_index(index)
        source = self._source_frame(physical_index)
        frame_key = self._frame_key(physical_index, source)
        if coordinates == "source":
            return replace(source, index=index, frame_key=frame_key)

        with self._unwrapped_lock:
            shifts = self._unwrapped_shifts(physical_index, source)
        cell = _frame_cell(source)
        return replace(
            source,
            index=index,
            frame_key=frame_key,
            coordinates="unwrapped",
            unwrapped_positions=apply_image_shifts(
                cell,
                source.positions,
                shifts,
            ),
            unwrapped_image_shifts=checked_int32(shifts),
            units={
                **source.units,
                "unwrapped_positions": source.units.get(
                    "positions",
                    "angstrom",
                ),
            },
        )

    def refresh(self) -> int:
        previous_count = self.frame_count
        previous_physical_count = self._physical_count
        for segment in self.segments:
            segment.source.refresh()
        self._rebuild_index()
        with self._unwrapped_lock:
            self._unwrapped_cache.clear()
            self._unwrapped_cache_bytes = 0
        if self._physical_count < previous_physical_count:
            return 0
        return max(0, self.frame_count - previous_count)

    def _rebuild_index(self) -> None:
        offsets = [0]
        for segment in self.segments:
            offsets.append(offsets[-1] + segment.source.frame_count)
        self._offsets = tuple(offsets)
        self._physical_count = offsets[-1]
        self._view_range = range(*self.frame_slice.indices(self._physical_count))

    def _physical_index(self, index: int) -> int:
        if index < 0 or index >= self.frame_count:
            raise IndexError(
                f"frame index {index} is outside 0..{self.frame_count - 1}"
            )
        return self._view_range[index]

    def _segment_index(self, physical_index: int) -> tuple[int, int]:
        if physical_index < 0 or physical_index >= self._physical_count:
            raise IndexError(physical_index)
        segment_index = bisect_right(self._offsets, physical_index) - 1
        return segment_index, physical_index - self._offsets[segment_index]

    def _frame_key(
        self,
        physical_index: int,
        frame: FrameData,
    ) -> FrameKey:
        segment_index, source_index = self._segment_index(physical_index)
        step_value = frame.scalars.get("step")
        time_value = frame.scalars.get("time")
        return FrameKey(
            source_id=self.segments[segment_index].source_id,
            source_index=source_index,
            segment_index=segment_index,
            step=(
                int(step_value)
                if isinstance(step_value, (int, np.integer))
                and not isinstance(step_value, (bool, np.bool_))
                else None
            ),
            time=(
                float(time_value)
                if isinstance(time_value, (int, float, np.integer, np.floating))
                and not isinstance(time_value, (bool, np.bool_))
                else None
            ),
            time_unit=frame.units.get("time"),
        )

    def _source_frame(self, physical_index: int) -> FrameData:
        segment_index, source_index = self._segment_index(physical_index)
        return self.segments[segment_index].source.get_frame(source_index)

    def _unwrapped_shifts(
        self,
        physical_index: int,
        source: FrameData,
    ) -> np.ndarray:
        nearest = self._nearest_unwrap_anchor(physical_index)
        if nearest is None:
            first = source if physical_index == 0 else self._source_frame(0)
            anchor_index = 0
            anchor = _make_unwrap_anchor(
                first,
                np.zeros(first.positions.shape, dtype=np.int64),
            )
            self._cache_unwrap_anchor(anchor_index, anchor)
        else:
            anchor_index, anchor = nearest

        if anchor_index < physical_index:
            previous = anchor
            for frame_index in range(anchor_index + 1, physical_index + 1):
                current_frame = (
                    source
                    if frame_index == physical_index
                    else self._source_frame(frame_index)
                )
                previous = _make_unwrap_anchor(
                    current_frame,
                    unwrap_image_step(
                        _anchor_cell(previous),
                        previous.positions,
                        _frame_cell(current_frame),
                        current_frame.positions,
                        current_frame.pbc,
                        previous.shifts,
                    ),
                )
            self._cache_unwrap_anchor(physical_index, previous)
            return previous.shifts.copy()

        if anchor_index > physical_index:
            current = anchor
            for frame_index in range(anchor_index - 1, physical_index - 1, -1):
                previous_frame = (
                    source
                    if frame_index == physical_index
                    else self._source_frame(frame_index)
                )
                if any(
                    before and not after
                    for before, after in zip(
                        previous_frame.pbc,
                        current.pbc,
                        strict=True,
                    )
                ):
                    return self._unwrapped_shifts_from_prior(
                        physical_index,
                        source,
                    )
                current = _make_unwrap_anchor(
                    previous_frame,
                    reverse_unwrap_image_step(
                        _frame_cell(previous_frame),
                        previous_frame.positions,
                        previous_frame.pbc,
                        _anchor_cell(current),
                        current.positions,
                        current.pbc,
                        current.shifts,
                    ),
                )
            self._cache_unwrap_anchor(physical_index, current)
            return current.shifts.copy()

        return anchor.shifts.copy()

    def _unwrapped_shifts_from_prior(
        self,
        physical_index: int,
        source: FrameData,
    ) -> np.ndarray:
        candidates = [
            candidate
            for candidate in self._unwrapped_cache
            if candidate <= physical_index
        ]
        if candidates:
            anchor_index = max(candidates)
            anchor = self._unwrapped_cache.pop(anchor_index)
            self._unwrapped_cache[anchor_index] = anchor
        else:
            first = source if physical_index == 0 else self._source_frame(0)
            anchor_index = 0
            anchor = _make_unwrap_anchor(
                first,
                np.zeros(first.positions.shape, dtype=np.int64),
            )
            self._cache_unwrap_anchor(anchor_index, anchor)

        previous = anchor
        for frame_index in range(anchor_index + 1, physical_index + 1):
            current_frame = (
                source
                if frame_index == physical_index
                else self._source_frame(frame_index)
            )
            previous = _make_unwrap_anchor(
                current_frame,
                unwrap_image_step(
                    _anchor_cell(previous),
                    previous.positions,
                    _frame_cell(current_frame),
                    current_frame.positions,
                    current_frame.pbc,
                    previous.shifts,
                ),
            )
        self._cache_unwrap_anchor(physical_index, previous)
        return previous.shifts.copy()

    def _nearest_unwrap_anchor(
        self,
        physical_index: int,
    ) -> tuple[int, _UnwrapAnchor] | None:
        if not self._unwrapped_cache:
            return None
        anchor_index = min(
            self._unwrapped_cache,
            key=lambda candidate: (
                abs(candidate - physical_index),
                candidate > physical_index,
            ),
        )
        anchor = self._unwrapped_cache.pop(anchor_index)
        self._unwrapped_cache[anchor_index] = anchor
        return anchor_index, anchor

    def _cache_unwrap_anchor(
        self,
        physical_index: int,
        anchor: _UnwrapAnchor,
    ) -> None:
        size = _unwrap_anchor_bytes(anchor)
        if size > self.UNWRAP_CACHE_BYTES:
            return
        replaced = self._unwrapped_cache.pop(physical_index, None)
        if replaced is not None:
            self._unwrapped_cache_bytes -= _unwrap_anchor_bytes(replaced)
        self._unwrapped_cache[physical_index] = anchor
        self._unwrapped_cache_bytes += size
        while (
            len(self._unwrapped_cache) > self.UNWRAP_CACHE_SIZE
            or self._unwrapped_cache_bytes > self.UNWRAP_CACHE_BYTES
        ):
            candidates = [
                candidate
                for candidate in self._unwrapped_cache
                if candidate not in {0, physical_index}
            ]
            if not candidates:
                candidates = [
                    candidate
                    for candidate in self._unwrapped_cache
                    if candidate != physical_index
                ]
            candidate = candidates[0] if candidates else physical_index
            removed = self._unwrapped_cache.pop(candidate)
            self._unwrapped_cache_bytes -= _unwrap_anchor_bytes(removed)

    def _validate_topologies(self) -> None:
        reference: tuple[int, tuple[int, ...]] | None = None
        for segment in self.segments:
            topology = segment.source.manifest().get("topology", {})
            atom_count = int(topology.get("atom_count", 0))
            atomic_numbers = tuple(
                int(value) for value in topology.get("atomic_numbers", [])
            )
            signature = atom_count, atomic_numbers
            if reference is None:
                reference = signature
            elif signature != reference:
                raise ValueError("run segments use different atom topologies")

    def _combined_properties(
        self,
        manifests: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        properties: dict[str, Any] = {}
        for manifest in manifests:
            for name, value in manifest.get("properties", {}).items():
                properties.setdefault(name, value)
        atom_count = int(
            manifests[0].get("topology", {}).get("atom_count", 0)
        )
        properties.setdefault(
            "centered_image_shifts",
            {
                "scope": "atom",
                "dtype": "int32",
                "shape": [atom_count, 3],
                "unit": None,
            },
        )
        properties.setdefault(
            "unwrapped_positions",
            {
                "scope": "atom",
                "dtype": "float32",
                "shape": [atom_count, 3],
                "unit": "angstrom",
                "coordinate_mode": "unwrapped",
            },
        )
        properties.setdefault(
            "unwrapped_image_shifts",
            {
                "scope": "atom",
                "dtype": "int32",
                "shape": [atom_count, 3],
                "unit": None,
                "coordinate_mode": "unwrapped",
            },
        )
        return properties

    def _combined_series(
        self,
        manifests: Sequence[Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        definitions: OrderedDict[str, dict[str, Any]] = OrderedDict()
        by_segment: list[dict[str, Mapping[str, Any]]] = []
        for manifest in manifests:
            current: dict[str, Mapping[str, Any]] = {}
            for entry in manifest.get("series", []):
                name = str(entry.get("name", "")).strip()
                if not name:
                    continue
                current[name] = entry
                definitions.setdefault(name, dict(entry))
            by_segment.append(current)

        result: list[dict[str, Any]] = []
        for name, definition in definitions.items():
            physical_values: list[Any] = []
            units: set[Any] = set()
            for segment, entries in zip(
                self.segments,
                by_segment,
                strict=True,
            ):
                entry = entries.get(name)
                values = list(entry.get("values", [])) if entry else []
                values = values[: segment.source.frame_count]
                values.extend(
                    [None] * (segment.source.frame_count - len(values))
                )
                physical_values.extend(values)
                if entry and entry.get("unit") is not None:
                    units.add(entry.get("unit"))
            combined = dict(definition)
            combined["values"] = [
                physical_values[index] for index in self._view_range
            ]
            combined["unit"] = units.pop() if len(units) == 1 else None
            result.append(combined)
        return result

    def _combined_companions(
        self,
        manifests: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        roles = {
            role
            for manifest in manifests
            for role in manifest.get("companion_files", {})
        }
        result: dict[str, Any] = {}
        for role in sorted(roles):
            entries = [
                manifest.get("companion_files", {}).get(role, {})
                for manifest in manifests
            ]
            result[role] = {
                "available": any(entry.get("available") for entry in entries),
                "frame_count": sum(
                    int(entry.get("frame_count", 0)) for entry in entries
                ),
                "files": [
                    entry.get("file")
                    for entry in entries
                    if entry.get("file")
                ],
                "alignment": "frame_key",
                "complete": all(
                    entry.get("complete", False) for entry in entries
                ),
            }
        return result


def open_run_dataset(
    source: str | Path | Any,
    *,
    energy_path: str | Path | None = None,
    info_path: str | Path | None = None,
    forces_path: str | Path | None = None,
    velocities_path: str | Path | None = None,
    charges_path: str | Path | None = None,
    moldescriptor_path: str | Path | None = None,
    topology_path: str | Path | None = None,
    frame_slice: slice | None = None,
    allowed_root: str | Path | None = None,
) -> RunDataset:
    """Resolve a PQ path or optional ASE object into one dataset contract."""
    overrides = {
        "energy": _optional_path(energy_path),
        "info": _optional_path(info_path),
        "forces": _optional_path(forces_path),
        "velocities": _optional_path(velocities_path),
        "charges": _optional_path(charges_path),
        "moldescriptor": _optional_path(moldescriptor_path),
        "topology": _optional_path(topology_path),
    }
    path, parsed_slice = _source_path_and_slice(source)
    resolved_root = (
        Path(allowed_root).expanduser().resolve()
        if allowed_root is not None
        else None
    )
    selected_slice = frame_slice or parsed_slice
    if frame_slice is not None and parsed_slice is not None:
        raise ValueError("frame slice was provided twice")

    if path is None:
        from .ase_adapter import ASEFrameSource

        ase_source = ASEFrameSource(source)
        return RunDataset(
            [
                SourceSegment(
                    source_id=ase_source.source_id,
                    source=ase_source,
                    kind="ase-object",
                )
            ],
            name=ase_source.name,
            frame_slice=selected_slice,
            provenance={"kind": "ase-object"},
        )

    if path.is_dir():
        segments = _segments_from_directory(path, overrides)
        return RunDataset(
            segments,
            name=path.name,
            frame_slice=selected_slice,
            provenance={"kind": "pq-run-directory", "path": str(path)},
        )
    if not path.is_file():
        raise FileNotFoundError(path)
    if path.suffix.lower() == ".in":
        files = _files_from_pq_input(path, allowed_root=resolved_root)
        files.update({key: value for key, value in overrides.items() if value})
        segment = _pq_segment(
            files["trajectory"],
            files,
            kind="pq-run-input",
            input_path=path,
        )
        return RunDataset(
            [segment],
            name=files["trajectory"].name,
            frame_slice=selected_slice,
            provenance={"kind": "pq-run-input", "path": str(path)},
        )
    if _is_xyz(path) and not _is_ase_extxyz(path, overrides):
        files = _discovered_pq_files(path)
        files.update({key: value for key, value in overrides.items() if value})
        segment = _pq_segment(path, files, kind="pq-trajectory")
        return RunDataset(
            [segment],
            name=path.name,
            frame_slice=selected_slice,
            provenance={"kind": "pq-trajectory", "path": str(path)},
        )

    from .ase_adapter import ASEFrameSource

    ase_source = ASEFrameSource(path)
    return RunDataset(
        [
            SourceSegment(
                source_id=ase_source.source_id,
                source=ase_source,
                kind="ase-file",
                path=path,
                files={"trajectory": path},
            )
        ],
        name=path.name,
        frame_slice=selected_slice,
        provenance={"kind": "ase-file", "path": str(path)},
    )


def parse_frame_slice(value: str) -> slice:
    """Parse start:stop:step using Python slice semantics."""
    parts = value.split(":")
    if len(parts) not in {2, 3}:
        raise ValueError("frame slice must use start:stop[:step]")
    parts.extend([""] * (3 - len(parts)))
    try:
        start, stop, step = (
            int(part) if part else None
            for part in parts
        )
    except ValueError as error:
        raise ValueError("frame slice values must be integers") from error
    if step == 0:
        raise ValueError("frame slice step cannot be zero")
    return slice(start, stop, step)


def _source_path_and_slice(
    source: str | Path | Any,
) -> tuple[Path | None, slice | None]:
    if isinstance(source, Path):
        return source.expanduser().resolve(), None
    if not isinstance(source, str):
        return None, None

    direct = Path(source).expanduser()
    if direct.exists():
        return direct.resolve(), None
    path_text, separator, slice_text = source.rpartition("@")
    if separator and ":" in slice_text:
        frame_slice = parse_frame_slice(slice_text)
        return Path(path_text).expanduser().resolve(), frame_slice
    return direct.resolve(), None


def _segments_from_directory(
    directory: Path,
    overrides: Mapping[str, Path | None],
) -> list[SourceSegment]:
    candidates: list[tuple[Path, dict[str, Path]]] = []
    for input_path in sorted(directory.glob("*.in"), key=_natural_path_key):
        try:
            files = _files_from_pq_input(input_path)
        except (FileNotFoundError, ValueError):
            continue
        candidates.append((input_path, files))

    if candidates:
        deduplicated: dict[Path, tuple[Path, dict[str, Path]]] = {}
        for input_path, files in candidates:
            deduplicated[files["trajectory"]] = (input_path, files)
        selected = _ordered_run_chain(list(deduplicated.values()), directory)
        return [
            _pq_segment(
                files["trajectory"],
                {
                    **files,
                    **{key: value for key, value in overrides.items() if value},
                },
                kind="pq-run-segment",
                input_path=input_path,
            )
            for input_path, files in selected
        ]

    trajectories = sorted(
        [
            path
            for path in directory.iterdir()
            if path.is_file() and _is_xyz(path)
        ],
        key=_natural_path_key,
    )
    if not trajectories:
        raise ValueError(f"no trajectory or PQ run input found in {directory}")
    if len(trajectories) > 1:
        names = ", ".join(path.name for path in trajectories)
        raise ValueError(
            f"multiple trajectories found in {directory}: {names}; "
            "open a trajectory or PQ input directly"
        )
    return [
        _pq_segment(
            path,
            {
                **_discovered_pq_files(path),
                **{key: value for key, value in overrides.items() if value},
            },
            kind="pq-run-segment",
        )
        for path in trajectories
    ]


def _ordered_run_chain(
    candidates: list[tuple[Path, dict[str, Path]]],
    directory: Path,
) -> list[tuple[Path, dict[str, Path]]]:
    if len(candidates) == 1:
        return candidates

    predecessors: dict[int, list[int]] = {
        index: [] for index in range(len(candidates))
    }
    successors: dict[int, list[int]] = {
        index: [] for index in range(len(candidates))
    }
    for before_index, (_, before) in enumerate(candidates):
        restart = before.get("restart")
        if restart is None:
            continue
        for after_index, (_, after) in enumerate(candidates):
            if before_index == after_index:
                continue
            if after.get("start") == restart:
                predecessors[after_index].append(before_index)
                successors[before_index].append(after_index)

    roots = [
        index
        for index, values in predecessors.items()
        if not values
    ]
    if len(roots) != 1 or any(
        len(values) > 1
        for values in [*predecessors.values(), *successors.values()]
    ):
        _raise_ambiguous_directory(candidates, directory)

    ordered: list[tuple[Path, dict[str, Path]]] = []
    seen: set[int] = set()
    current = roots[0]
    while current not in seen:
        seen.add(current)
        ordered.append(candidates[current])
        next_values = successors[current]
        if not next_values:
            break
        current = next_values[0]
    if len(seen) != len(candidates):
        _raise_ambiguous_directory(candidates, directory)
    return ordered


def _raise_ambiguous_directory(
    candidates: Sequence[tuple[Path, Mapping[str, Path]]],
    directory: Path,
) -> None:
    names = ", ".join(input_path.name for input_path, _ in candidates)
    raise ValueError(
        f"multiple unrelated PQ runs found in {directory}: {names}; "
        "open a run input directly"
    )


def _files_from_pq_input(
    input_path: Path,
    *,
    allowed_root: Path | None = None,
) -> dict[str, Path]:
    dictionary = _read_pq_input(input_path)
    directory = input_path.parent

    normal = _input_family_files(
        dictionary,
        directory,
        "",
        allowed_root=allowed_root,
    )
    rpmd = _input_family_files(
        dictionary,
        directory,
        "rpmd_",
        allowed_root=allowed_root,
    )
    families = [
        files
        for files in (normal, rpmd)
        if files.get("trajectory", Path()).is_file()
    ]
    if not families:
        expected = [
            files.get("trajectory")
            for files in (normal, rpmd)
            if files.get("trajectory") is not None
        ]
        detail = ", ".join(str(path) for path in expected)
        raise FileNotFoundError(detail or f"trajectory from {input_path}")
    files = families[0]

    moldescriptor = directory / "moldescriptor.dat"
    if moldescriptor.is_file():
        files["moldescriptor"] = moldescriptor.resolve()
    return files


def _read_pq_input(input_path: Path) -> Any:
    reader = PQInputFileReader(str(input_path))
    try:
        reader.read()
        return reader.dictionary
    except Exception as reader_error:
        text = input_path.read_text(encoding="utf-8")
        uncommented = re.sub(r"(?m)#.*$", "", text)
        assignments: dict[str, str] = {}
        pattern = re.compile(
            r"\b(" + "|".join(sorted(_PQ_FILE_KEYS)) + r")\b"
            r"\s*=\s*(\"[^\"]*\"|'[^']*'|[^;]+)\s*;",
            re.IGNORECASE,
        )
        for match in pattern.finditer(uncommented):
            key = match.group(1).casefold()
            value = match.group(2).strip().strip("\"'")
            if value:
                assignments[key] = value
        if (
            not assignments
            or not {"start_file", "rpmd_start_file"} & assignments.keys()
            or not {"traj_file", "rpmd_traj_file", "file_prefix"}
            & assignments.keys()
        ):
            raise reader_error
        return assignments


def _input_family_files(
    dictionary: Any,
    directory: Path,
    prefix: str,
    *,
    allowed_root: Path | None = None,
) -> dict[str, Path]:
    keys = {
        "trajectory": f"{prefix}traj_file",
        "velocities": f"{prefix}vel_file",
        "forces": f"{prefix}force_file",
        "charges": f"{prefix}charge_file",
        "energy": f"{prefix}energy_file",
        "restart": f"{prefix}restart_file",
    }
    result: dict[str, Path] = {}
    for role, key in keys.items():
        value = _input_value(dictionary, key)
        if value:
            result[role] = _relative_path(
                directory,
                value,
                allowed_root=allowed_root,
            )
    info = _input_value(dictionary, "info_file")
    if info:
        result["info"] = _relative_path(
            directory,
            info,
            allowed_root=allowed_root,
        )

    file_prefix = _input_value(dictionary, "file_prefix")
    if file_prefix:
        base = _relative_path(
            directory,
            file_prefix,
            allowed_root=allowed_root,
        )
        suffixes = (
            {
                "trajectory": ".xyz",
                "velocities": ".vel",
                "forces": ".force",
                "charges": ".chrg",
                "energy": ".en",
                "info": ".info",
                "restart": ".rst",
            }
            if not prefix
            else {
                "trajectory": ".rpmd.xyz",
                "velocities": ".rpmd.vel",
                "forces": ".rpmd.force",
                "charges": ".rpmd.chrg",
                "energy": ".rpmd.en",
                "restart": ".rpmd.rst",
            }
        )
        for role, suffix in suffixes.items():
            result.setdefault(role, base.with_name(f"{base.name}{suffix}"))

    start = _input_value(dictionary, f"{prefix}start_file")
    if start:
        result["start"] = _relative_path(
            directory,
            start,
            allowed_root=allowed_root,
        )
    return {
        role: path.resolve()
        for role, path in result.items()
        if role == "trajectory" or path.is_file()
    }


def _pq_segment(
    trajectory: Path,
    files: Mapping[str, Path],
    *,
    kind: str,
    input_path: Path | None = None,
) -> SourceSegment:
    reference_residues = _read_reference_residues(
        files.get("moldescriptor")
    )
    topology = _restart_topology(files, reference_residues)
    dataset = PQTrajectoryDataset(
        trajectory,
        energy_path=files.get("energy"),
        info_path=files.get("info"),
        forces_path=files.get("forces"),
        velocities_path=files.get("velocities"),
        charges_path=files.get("charges"),
        topology_path=files.get("topology"),
        topology=topology,
        reference_residues=(
            None if topology is not None else reference_residues
        ),
    )
    return SourceSegment(
        source_id=str(trajectory),
        source=dataset,
        kind=kind,
        path=trajectory,
        input_path=input_path,
        files=dict(files),
    )


def _restart_topology(
    files: Mapping[str, Path],
    reference_residues: Sequence[Any] | None,
) -> Any | None:
    restart = files.get("restart") or files.get("start")
    if restart is None or not restart.is_file():
        return None
    try:
        system = read_restart_file(
            str(restart),
            reference_residues=reference_residues,
        )
    except Exception:
        try:
            system = read_restart_file(str(restart))
        except Exception:  # Optional topology enrichment must not block a run.
            return None
    return system.topology


def _read_reference_residues(path: Path | None) -> Sequence[Any] | None:
    if path is None:
        return None
    try:
        return MoldescriptorReader(str(path)).read()
    except UnicodeDecodeError:
        try:
            text = path.read_bytes().decode("iso-8859-1")
            with NamedTemporaryFile(
                mode="w",
                suffix=".dat",
                encoding="utf-8",
            ) as converted:
                converted.write(text)
                converted.flush()
                return MoldescriptorReader(converted.name).read()
        except Exception:
            return None
    except Exception:
        return None


def _discovered_pq_files(trajectory: Path) -> dict[str, Path]:
    stem = _trajectory_stem(trajectory)
    files: dict[str, Path] = {"trajectory": trajectory}
    candidates = {
        "energy": [f"{stem}.en"],
        "info": [f"{stem}.info"],
        "restart": [f"{stem}.rst"],
        "moldescriptor": ["moldescriptor.dat"],
    }
    for role, names in candidates.items():
        matches = [
            trajectory.with_name(name)
            for name in names
            if trajectory.with_name(name).is_file()
        ]
        if len(matches) == 1:
            files[role] = matches[0]
    return files


def _slice_manifest(frame_slice: slice) -> dict[str, int | None]:
    return {
        "start": frame_slice.start,
        "stop": frame_slice.stop,
        "step": frame_slice.step,
    }


def _input_value(
    dictionary: Any,
    key: str,
) -> str | None:
    if key not in dictionary.keys():
        return None
    value = (
        dictionary.get_value(key)
        if hasattr(dictionary, "get_value")
        else dictionary[key]
    )
    if value is None:
        return None
    if isinstance(value, Sequence) and not isinstance(value, str):
        if not value:
            return None
        value = value[0]
    return str(value)


def _relative_path(
    directory: Path,
    value: str,
    *,
    allowed_root: Path | None = None,
) -> Path:
    path = Path(value).expanduser()
    resolved = (path if path.is_absolute() else directory / path).resolve()
    if allowed_root is not None and not resolved.is_relative_to(allowed_root):
        raise ValueError("PQ input path leaves the uploaded bundle")
    return resolved


def _optional_path(value: str | Path | None) -> Path | None:
    if value is None:
        return None
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(path)
    return path


def _is_xyz(path: Path) -> bool:
    return path.name.lower().endswith((".xyz", ".extxyz", ".extended.xyz"))


def _is_ase_extxyz(
    path: Path,
    overrides: Mapping[str, Path | None],
) -> bool:
    if any(overrides.values()):
        return False
    try:
        with path.open("rb") as handle:
            handle.readline(256)
            comment = handle.readline(65_536).decode("utf-8", errors="replace")
    except OSError:
        return False
    match = re.search(r"\bProperties=([^\s]+)", comment, re.IGNORECASE)
    if match is None:
        return False
    parts = match.group(1).strip("\"'").casefold().split(":")
    property_names = set(parts[0::3])
    ase_properties = {
        "forces",
        "initial_charges",
        "initial_magmoms",
        "magmoms",
        "momenta",
        "stress",
    }
    if re.search(r"\bforces?_units?=", comment, re.IGNORECASE):
        ase_properties.remove("forces")
    return bool(property_names & ase_properties) or bool(
        re.search(r"\b(?:energy|free_energy|stress)=", comment, re.IGNORECASE)
    )


def _trajectory_stem(path: Path) -> str:
    lowered = path.name.lower()
    for suffix in (".extended.xyz", ".extxyz", ".xyz"):
        if lowered.endswith(suffix):
            return path.name[: -len(suffix)]
    return path.stem


def _natural_path_key(path: Path) -> tuple[Any, ...]:
    return tuple(
        int(part) if part.isdigit() else part.casefold()
        for part in re.split(r"(\d+)", path.name)
    )


def _make_unwrap_anchor(
    frame: FrameData,
    shifts: np.ndarray,
) -> _UnwrapAnchor:
    cell = (
        frame.periodic_cell
        if frame.periodic_cell is not None
        else frame.cell
    )
    return _UnwrapAnchor(
        positions=frame.positions.copy(),
        cell=cell.copy(),
        pbc=frame.pbc,
        shifts=np.asarray(shifts, dtype=np.int64).copy(),
    )


def _frame_cell(frame: FrameData) -> Cell:
    matrix = np.asarray(
        frame.periodic_cell
        if frame.periodic_cell is not None
        else frame.cell,
        dtype=np.float64,
    )
    if not np.any(matrix):
        return Cell()
    return Cell.init_from_box_matrix(matrix.T)


def _anchor_cell(anchor: _UnwrapAnchor) -> Cell:
    matrix = np.asarray(anchor.cell, dtype=np.float64)
    if not np.any(matrix):
        return Cell()
    return Cell.init_from_box_matrix(matrix.T)


def _unwrap_anchor_bytes(anchor: _UnwrapAnchor) -> int:
    return anchor.positions.nbytes + anchor.cell.nbytes + anchor.shifts.nbytes
