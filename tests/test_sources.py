"""Tests for unified PQ and ASE data sources."""

from __future__ import annotations

import json
from pathlib import Path
import struct

from ase import Atoms, units
from ase.calculators.calculator import Calculator
from ase.calculators.singlepoint import SinglePointCalculator
from ase.io import Trajectory, write
import numpy as np
import pytest

from pqviewer.ase_adapter import _require_ase
from pqviewer.data import FrameData, PQTrajectoryDataset
from pqviewer.packet import encode_frame
from pqviewer.sources import (
    RunDataset,
    SourceSegment,
    open_run_dataset,
    parse_frame_slice,
)


def test_parse_frame_slice_uses_python_semantics() -> None:
    assert parse_frame_slice("1:9:2") == slice(1, 9, 2)
    assert parse_frame_slice("::-1") == slice(None, None, -1)
    assert parse_frame_slice(":4") == slice(None, 4, None)
    with pytest.raises(ValueError, match="start:stop"):
        parse_frame_slice("4")
    with pytest.raises(ValueError, match="zero"):
        parse_frame_slice("::0")


def test_sliced_source_preserves_frame_keys_and_series(tmp_path: Path) -> None:
    path = tmp_path / "steps.xyz"
    path.write_text(
        _trajectory([4.8, -4.9, -4.7, -4.5]),
        encoding="utf-8",
    )

    dataset = open_run_dataset(f"{path}@1:4:2")
    manifest = dataset.manifest()
    frame = dataset.get_frame(1, coordinates="unwrapped")
    packet = encode_frame(frame)
    header_size = struct.unpack_from("<I", packet)[0]
    header = json.loads(packet[4:4 + header_size])

    assert dataset.frame_count == 2
    assert manifest["source"]["slice"] == {
        "start": 1,
        "stop": 4,
        "step": 2,
    }
    step_series = next(
        entry for entry in manifest["series"] if entry["name"] == "step"
    )
    assert step_series["values"] == [1, 3]
    assert frame.frame_key is not None
    assert frame.frame_key.source_index == 3
    assert frame.frame_key.step == 3
    assert frame.unwrapped_positions[0, 0] == pytest.approx(5.5)
    assert header["frame_key"]["source_index"] == 3
    assert header["frame_key"]["step"] == 3


def test_large_indexed_source_stays_lazy_when_sliced() -> None:
    source = _CountingSource(1_000_000)
    selected = range(13, source.frame_count, 17)
    dataset = RunDataset(
        [
            SourceSegment(
                source_id="large-run",
                source=source,
                kind="test",
            )
        ],
        frame_slice=slice(13, None, 17),
    )

    assert dataset.frame_count == len(selected)
    assert source.read_indices == []

    manifest = dataset.manifest()
    frame = dataset.get_frame(dataset.frame_count - 1)

    assert manifest["frame_count"] == len(selected)
    assert source.read_indices == [selected[-1]]
    assert frame.frame_key is not None
    assert frame.frame_key.source_index == selected[-1]


def test_restart_segments_keep_unwrapped_continuity_and_identity(
    tmp_path: Path,
) -> None:
    first_path = tmp_path / "run-a.xyz"
    second_path = tmp_path / "run-b.xyz"
    first_path.write_text(_trajectory([4.8, -4.9]), encoding="utf-8")
    second_path.write_text(_trajectory([-4.7, -4.5]), encoding="utf-8")
    dataset = RunDataset(
        [
            SourceSegment(
                source_id="run-a",
                source=PQTrajectoryDataset(first_path),
                kind="pq-run-segment",
                path=first_path,
            ),
            SourceSegment(
                source_id="run-b",
                source=PQTrajectoryDataset(second_path),
                kind="pq-run-segment",
                path=second_path,
            ),
        ],
    )

    frame = dataset.get_frame(3, coordinates="unwrapped")

    assert frame.frame_key is not None
    assert frame.frame_key.source_id == "run-b"
    assert frame.frame_key.segment_index == 1
    assert frame.frame_key.source_index == 1
    assert frame.frame_key.step == 1
    assert frame.unwrapped_positions[0, 0] == pytest.approx(5.5)


def test_pq_input_resolves_prefix_outputs_and_explicit_overrides(
    tmp_path: Path,
) -> None:
    (tmp_path / "initial.rst").write_text("not needed", encoding="utf-8")
    (tmp_path / "run.xyz").write_text(
        _trajectory([0.0, 0.1]),
        encoding="utf-8",
    )
    (tmp_path / "custom.frc").write_text(
        _companion([[1, 2, 3], [4, 5, 6]]),
        encoding="utf-8",
    )
    input_path = tmp_path / "run.in"
    input_path.write_text(
        """
start_file = initial.rst;
file_prefix = run;
force_file = custom.frc;
""",
        encoding="utf-8",
    )

    dataset = open_run_dataset(input_path)
    manifest = dataset.manifest()

    assert dataset.frame_count == 2
    assert manifest["source"]["kind"] == "pq-run-input"
    assert manifest["source"]["segments"][0]["files"]["forces"].endswith(
        "custom.frc"
    )
    np.testing.assert_allclose(
        dataset.get_frame(1).forces,
        [[4, 5, 6]],
    )


def test_pq_input_fallback_resolves_relative_subdirectories(
    tmp_path: Path,
) -> None:
    output = tmp_path / "output"
    output.mkdir()
    (output / "initial.rst").write_text("not needed", encoding="utf-8")
    (output / "run.xyz").write_text(_trajectory([0.0]), encoding="utf-8")
    input_path = tmp_path / "run.in"
    input_path.write_text(
        (
            "start_file = output/initial.rst;\n"
            "traj_file = output/run.xyz;\n"
        ),
        encoding="utf-8",
    )

    dataset = open_run_dataset(input_path)

    assert dataset.frame_count == 1
    assert dataset.path == (output / "run.xyz").resolve()


def test_run_directory_orders_restart_chain_from_declared_files(
    tmp_path: Path,
) -> None:
    (tmp_path / "initial.rst").write_text("initial", encoding="utf-8")
    _write_run_segment(
        tmp_path,
        "run-01",
        "segment-01",
        "initial.rst",
        [4.8, -4.9],
    )
    _write_run_segment(
        tmp_path,
        "run-02",
        "segment-02",
        "segment-01.rst",
        [-4.7, -4.5],
    )

    dataset = open_run_dataset(tmp_path)
    frame = dataset.get_frame(3, coordinates="unwrapped")

    assert dataset.frame_count == 4
    assert len(dataset.manifest()["source"]["segments"]) == 2
    assert frame.frame_key is not None
    assert frame.frame_key.segment_index == 1
    assert frame.unwrapped_positions[0, 0] == pytest.approx(5.5)


def test_run_directory_rejects_unrelated_inputs(tmp_path: Path) -> None:
    for prefix in ("alpha", "beta"):
        (tmp_path / f"{prefix}-start.rst").write_text(
            "initial",
            encoding="utf-8",
        )
        _write_run_segment(
            tmp_path,
            f"{prefix}-run",
            prefix,
            f"{prefix}-start.rst",
            [0.0],
        )

    with pytest.raises(ValueError, match="multiple unrelated PQ runs"):
        open_run_dataset(tmp_path)


def test_run_directory_rejects_unrelated_trajectories(tmp_path: Path) -> None:
    (tmp_path / "a.xyz").write_text(_trajectory([0.0]), encoding="utf-8")
    (tmp_path / "b.xyz").write_text(_trajectory([0.0]), encoding="utf-8")

    with pytest.raises(ValueError, match="multiple trajectories"):
        open_run_dataset(tmp_path)


def test_ase_atoms_preserve_cell_properties_and_do_not_calculate() -> None:
    cell = np.array([
        [4.0, 0.0, 0.0],
        [1.2, 3.5, 0.0],
        [0.4, 0.7, 5.0],
    ])
    atoms = Atoms(
        "OH2",
        positions=[[1, 0, 0], [1.8, 0, 0], [0.8, 0.7, 0]],
        cell=cell,
        pbc=[True, False, True],
        info={"step": 12, "time": 1.5},
    )
    calculator = _NoCalculate()
    calculator.results = {
        "energy": -4.2,
        "forces": np.arange(9).reshape(3, 3) * 0.1,
        "charges": np.array([-0.8, 0.4, 0.4]),
    }
    atoms.calc = calculator
    atoms.set_velocities(np.full((3, 3), 0.02))

    dataset = open_run_dataset(atoms)
    frame = dataset.get_frame(0)
    manifest = dataset.manifest()

    np.testing.assert_allclose(frame.cell, cell)
    np.testing.assert_allclose(frame.forces, calculator.results["forces"])
    np.testing.assert_allclose(frame.charges, [-0.8, 0.4, 0.4])
    np.testing.assert_allclose(
        frame.velocities,
        atoms.get_velocities() * units.fs,
    )
    assert frame.pbc == (True, False, True)
    assert frame.scalars["energy"] == pytest.approx(-4.2)
    assert frame.units["forces"] == "eV/angstrom"
    assert manifest["properties"]["unwrapped_positions"]["unit"] == "angstrom"
    assert calculator.calculate_calls == 0


def test_ase_extxyz_keeps_ase_properties(tmp_path: Path) -> None:
    path = tmp_path / "optimization.extxyz"
    atoms = Atoms(
        "H2",
        positions=[[0, 0, 0], [0, 0, 0.7]],
        cell=[5, 5, 5],
        pbc=True,
    )
    atoms.set_velocities([[0.1, 0, 0], [0, 0.2, 0]])
    atoms.set_initial_charges([0.1, -0.1])
    atoms.calc = SinglePointCalculator(
        atoms,
        energy=-1.0,
        forces=np.ones((2, 3)),
    )
    write(path, atoms)

    dataset = open_run_dataset(path)
    frame = dataset.get_frame(0)

    assert dataset.manifest()["source"]["kind"] == "ase-file"
    np.testing.assert_allclose(
        frame.velocities,
        atoms.get_velocities() * units.fs,
    )
    np.testing.assert_allclose(frame.charges, [0.1, -0.1])
    np.testing.assert_allclose(frame.forces, np.ones((2, 3)))
    assert frame.scalars["energy"] == pytest.approx(-1.0)
    assert frame.units["forces"] == "eV/angstrom"


def test_forces_only_ase_extxyz_keeps_force_units(tmp_path: Path) -> None:
    path = tmp_path / "forces.extxyz"
    atoms = Atoms("H", positions=[[0, 0, 0]])
    atoms.calc = SinglePointCalculator(
        atoms,
        forces=np.array([[1.0, 2.0, 3.0]]),
    )
    write(path, atoms)

    dataset = open_run_dataset(path)
    frame = dataset.get_frame(0)

    assert dataset.manifest()["source"]["kind"] == "ase-file"
    np.testing.assert_allclose(frame.forces, [[1.0, 2.0, 3.0]])
    assert frame.units["forces"] == "eV/angstrom"


@pytest.mark.filterwarnings(
    "ignore:Setting the shape on a NumPy array has been deprecated:DeprecationWarning"
)
def test_ase_native_trajectory_is_indexed_and_unwrapped(tmp_path: Path) -> None:
    path = tmp_path / "crossing.traj"
    with Trajectory(path, mode="w") as trajectory:
        for index, position in enumerate((4.8, -4.9, -4.7)):
            atoms = Atoms(
                "H",
                positions=[[position, 0, 0]],
                cell=[10, 10, 10],
                pbc=True,
                info={"step": index},
            )
            trajectory.write(atoms)

    dataset = open_run_dataset(path)
    frame = dataset.get_frame(2, coordinates="unwrapped")

    assert dataset.frame_count == 3
    assert dataset.manifest()["ase_format"] == "traj"
    assert frame.frame_key is not None
    assert frame.frame_key.source_index == 2
    assert frame.unwrapped_positions[0, 0] == pytest.approx(5.3)


def test_ase_sequence_rejects_topology_changes_when_decoded() -> None:
    dataset = open_run_dataset([Atoms("H"), Atoms("He")])

    with pytest.raises(ValueError, match="topology changed"):
        dataset.get_frame(1)


def test_ase_missing_message_is_actionable(monkeypatch: pytest.MonkeyPatch) -> None:
    import builtins

    original_import = builtins.__import__

    def unavailable(name, *args, **kwargs):
        if name == "ase":
            raise ImportError("missing")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", unavailable)
    with pytest.raises(RuntimeError, match=r"pqanalysis-viewer\[ase\]"):
        _require_ase()


class _NoCalculate(Calculator):
    implemented_properties = ["energy", "forces", "charges"]

    def __init__(self) -> None:
        super().__init__()
        self.calculate_calls = 0

    def calculate(self, *args, **kwargs) -> None:
        self.calculate_calls += 1
        raise AssertionError("calculator was triggered")


class _CountingSource:
    name = "large.xyz"

    def __init__(self, frame_count: int) -> None:
        self.frame_count = frame_count
        self.read_indices: list[int] = []

    def manifest(self) -> dict:
        return {
            "name": self.name,
            "frame_count": self.frame_count,
            "topology": {
                "atom_count": 1,
                "atomic_numbers": [1],
            },
            "properties": {},
            "series": [],
            "companion_files": {},
        }

    def get_frame(self, index: int) -> FrameData:
        self.read_indices.append(index)
        return FrameData(
            index=index,
            positions=np.array([[float(index), 0.0, 0.0]]),
            cell=np.eye(3) * 10.0,
            pbc=(True, True, True),
            centered_image_shifts=np.zeros((1, 3), dtype=np.int32),
        )

    def refresh(self) -> int:
        return 0


def _trajectory(positions: list[float]) -> str:
    return "".join(
        (
            "1 10 10 10\n"
            f'pbc="T T T" step={index} time={index * 0.5} time_unit=fs\n'
            f"H {position} 0 0\n"
        )
        for index, position in enumerate(positions)
    )


def _companion(values: list[list[float]]) -> str:
    return "".join(
        "1\n\n"
        f"H {x} {y} {z}\n"
        for x, y, z in values
    )


def _write_run_segment(
    directory: Path,
    input_name: str,
    prefix: str,
    start_file: str,
    positions: list[float],
) -> None:
    (directory / f"{prefix}.xyz").write_text(
        _trajectory(positions),
        encoding="utf-8",
    )
    (directory / f"{prefix}.rst").write_text(
        "optional topology",
        encoding="utf-8",
    )
    (directory / f"{input_name}.in").write_text(
        (
            f"start_file = {start_file};\n"
            f"file_prefix = {prefix};\n"
        ),
        encoding="utf-8",
    )
