"""Focused ASE adapter regressions."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ase import Atoms
from ase.io import Trajectory, write
from ase.io.trajectory import TrajectoryReader
import numpy as np
import pytest

from pqviewer.ase_adapter import ASEFrameSource
from pqviewer.sources import RunDataset, SourceSegment


@pytest.mark.parametrize(
    ("cell", "pbc"),
    [
        (np.diag([10.0, 0.0, 0.0]), [True, False, False]),
        (np.diag([10.0, 8.0, 0.0]), [True, True, False]),
    ],
)
def test_low_rank_cell_stays_exact_and_unwraps(
    cell: np.ndarray,
    pbc: list[bool],
) -> None:
    atoms = [
        Atoms("H", positions=[[4.8, 1.0, 0.0]], cell=cell, pbc=pbc),
        Atoms("H", positions=[[-4.9, 1.0, 0.0]], cell=cell, pbc=pbc),
    ]
    source = ASEFrameSource(atoms)
    dataset = RunDataset([
        SourceSegment(source_id="low-rank", source=source, kind="ase")
    ])

    source_frame = source.get_frame(0)
    unwrapped = dataset.get_frame(1, coordinates="unwrapped")

    np.testing.assert_array_equal(source_frame.cell, cell)
    np.testing.assert_array_equal(unwrapped.cell, cell)
    assert source_frame.periodic_cell is not None
    assert np.all(np.isfinite(source_frame.periodic_cell))
    assert abs(np.linalg.det(source_frame.periodic_cell)) > 1e-12
    assert np.all(np.isfinite(unwrapped.unwrapped_positions))
    assert unwrapped.unwrapped_positions[0, 0] == pytest.approx(5.1)


def test_trajectory_reader_is_accepted_without_treating_strings_as_readers(
    tmp_path: Path,
) -> None:
    path = tmp_path / "indexed.traj"
    with Trajectory(path, mode="w") as writer:
        writer.write(Atoms("H", positions=[[0.0, 0.0, 0.0]]))
        writer.write(Atoms("H", positions=[[1.0, 0.0, 0.0]]))

    reader = TrajectoryReader(path)
    try:
        source = ASEFrameSource(reader)
        assert source.frame_count == 2
        np.testing.assert_allclose(
            source.get_frame(1).positions,
            [[1.0, 0.0, 0.0]],
        )
    finally:
        reader.close()

    with pytest.raises(FileNotFoundError):
        ASEFrameSource(str(tmp_path / "not-a-source"))


def test_stale_calculator_results_are_suppressed() -> None:
    atoms = Atoms("H", positions=[[0.0, 0.0, 0.0]])
    calculator = _StaleCalculator(atoms)
    atoms.calc = calculator

    source = ASEFrameSource(atoms)
    frame = source.get_frame(0)
    manifest = source.manifest()

    assert frame.forces is None
    assert "energy" not in frame.scalars
    assert "forces" not in manifest["properties"]
    assert "energy" not in manifest["properties"]
    assert calculator.calculate_calls == 0
    assert calculator.check_calls >= 2


def test_generic_playback_is_sequential_and_cache_is_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame_count = 40
    path = tmp_path / "many.extxyz"
    write(
        path,
        [
            Atoms(
                "H",
                positions=[[float(index), 0.0, 0.0]],
                info={"step": index},
            )
            for index in range(frame_count)
        ],
        format="extxyz",
    )

    import ase.io

    original_iread = ase.io.iread
    yielded = 0

    def counted_iread(*args: Any, **kwargs: Any):
        nonlocal yielded
        for atoms in original_iread(*args, **kwargs):
            yielded += 1
            yield atoms

    monkeypatch.setattr(ase.io, "iread", counted_iread)
    source = ASEFrameSource(path)
    assert source.manifest()["series"][0]["values"] == list(range(frame_count))

    for index in range(frame_count):
        assert source.get_frame(index).positions[0, 0] == pytest.approx(index)

    assert yielded == 2 * frame_count
    assert len(source._generic_cache) <= source.GENERIC_CACHE_SIZE
    assert source._generic_cache_bytes <= source.GENERIC_CACHE_BYTES


@pytest.mark.parametrize("name", ["POSCAR", "sample.contcar"])
def test_vasp_names_use_explicit_format(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
) -> None:
    path = tmp_path / name
    write(path, Atoms("H", cell=[5, 5, 5], pbc=True), format="vasp")

    import ase.io

    original_iread = ase.io.iread
    formats: list[str | None] = []

    def recorded_iread(*args: Any, **kwargs: Any):
        formats.append(kwargs.get("format"))
        yield from original_iread(*args, **kwargs)

    monkeypatch.setattr(ase.io, "iread", recorded_iread)
    source = ASEFrameSource(path)

    assert source.get_frame(0).positions.shape == (1, 3)
    assert formats == ["vasp", "vasp"]


def test_pdb_secondary_structure_records_are_preserved() -> None:
    path = Path(__file__).resolve().parents[1] / "docs" / "assets" / "sources" / "1CRN.pdb"
    residues = ASEFrameSource(path).manifest()["topology"]["residues"]
    structures = [residue["secondary_structure"] for residue in residues]

    assert len(residues) == 46
    assert structures.count("helix") == 21
    assert structures.count("sheet") == 8
    assert structures.count("coil") == 17


def test_pdb_blank_chain_ter_segments_stay_separate(tmp_path: Path) -> None:
    lines: list[str] = []
    serial = 1
    for segment in range(2):
        for residue in range(1, 4):
            for atom_name, element, offset in [
                ("N", "N", 0.0),
                ("CA", "C", 1.2),
                ("C", "C", 2.4),
                ("O", "O", 3.2),
            ]:
                x = segment * 30 + residue * 4 + offset
                lines.append(
                    f"ATOM  {serial:5d} {atom_name:^4s} ALA  {residue:4d}    "
                    f"{x:8.3f}{0.0:8.3f}{0.0:8.3f}  1.00 20.00          {element:>2s}"
                )
                serial += 1
        if segment == 0:
            lines.append(f"TER   {serial:5d}      ALA     3")
            serial += 1
    lines.append("END")
    path = tmp_path / "segments.pdb"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    topology = ASEFrameSource(path).manifest()["topology"]
    residues = topology["residues"]

    assert len(residues) == 6
    assert [residue["chain_id"] for residue in residues] == [None] * 6
    assert [residue["segment_id"] for residue in residues] == [0, 0, 0, 1, 1, 1]
    assert [residue["sequence_number"] for residue in residues] == [1, 2, 3, 1, 2, 3]
    assert topology["residue_ids"][0].startswith("_s0:")
    assert topology["residue_ids"][-1].startswith("_s1:")


def test_step_and_time_series_preserve_declared_units() -> None:
    source = ASEFrameSource([
        Atoms("H", info={"step": 4, "time": 0.5, "time_unit": "fs"}),
        Atoms("H", info={"step": 5, "time": 1.0, "time_unit": "fs"}),
    ])

    manifest = source.manifest()
    series = {entry["name"]: entry for entry in manifest["series"]}
    frame = source.get_frame(1)

    assert series["step"]["values"] == [4, 5]
    assert series["time"]["values"] == [0.5, 1.0]
    assert series["time"]["unit"] == "fs"
    assert manifest["properties"]["time"]["unit"] == "fs"
    assert frame.scalars["step"] == 5
    assert frame.scalars["time"] == pytest.approx(1.0)
    assert frame.units["time"] == "fs"


def test_large_indexed_source_does_not_scan_for_series() -> None:
    trajectory = _CountingTrajectory(10_000)
    source = ASEFrameSource(trajectory)
    dataset = RunDataset(
        [SourceSegment(source_id="large", source=source, kind="ase")],
        frame_slice=slice(0, 10),
    )

    manifest = dataset.manifest()

    assert trajectory.read_indices == [0, 0]
    assert manifest["series"] == []
    assert manifest["series_deferred"] is True
    assert dataset.frame_count == 10
    assert dataset.get_frame(9).frame_key.source_index == 9
    assert trajectory.read_indices[-1] == 9


class _StaleCalculator:
    def __init__(self, atoms: Atoms) -> None:
        self.atoms = atoms.copy()
        self.results = {
            "energy": -1.0,
            "forces": np.zeros((1, 3)),
        }
        self.check_calls = 0
        self.calculate_calls = 0

    def check_state(self, atoms: Atoms) -> list[str]:
        self.check_calls += 1
        return ["positions"]

    def calculate(self, *args: Any, **kwargs: Any) -> None:
        self.calculate_calls += 1
        raise AssertionError("calculation was triggered")


class _CountingTrajectory:
    def __init__(self, frame_count: int) -> None:
        self.frame_count = frame_count
        self.read_indices: list[int] = []

    def __len__(self) -> int:
        return self.frame_count

    def __getitem__(self, index: int) -> Atoms:
        self.read_indices.append(index)
        return Atoms(
            "H",
            positions=[[float(index), 0.0, 0.0]],
            info={"step": index},
        )
