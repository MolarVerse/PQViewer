from __future__ import annotations

import json
from pathlib import Path
import struct

import numpy as np
import pytest

from PQAnalysis.core import Atom
from PQAnalysis.topology import Bond, BondedTopology, Topology

from pqviewer.data import PQTrajectoryDataset
from pqviewer.packet import encode_frame


XYZ = """2 10 11 12
step=0 energy=-1.5 energy_unit=eV
H 0.0 0.0 0.0
O 1.0 0.0 0.0
2 10 11 12
step=1 energy=-1.0 energy_unit=eV
H 0.1 0.2 0.3
O 1.1 0.2 0.3
"""


def test_indexes_manifest_and_random_access(tmp_path: Path) -> None:
    path = tmp_path / "water.xyz"
    path.write_text(XYZ, encoding="utf-8")

    dataset = PQTrajectoryDataset(path)
    manifest = dataset.manifest()
    frame = dataset.get_frame(1)

    assert manifest["schema_version"] == 1
    assert manifest["frame_count"] == 2
    assert manifest["topology"] == {
        "atom_count": 2,
        "atomic_numbers": [1, 8],
        "symbols": ["H", "O"],
        "atom_names": ["H", "O"],
        "residue_ids": [0, 0],
        "bonds": [],
    }
    assert manifest["properties"]["positions"]["unit"] == "angstrom"
    assert next(item for item in manifest["series"] if item["name"] == "energy") == {
        "name": "energy",
        "label": "energy",
        "unit": "eV",
        "values": [-1.5, -1.0],
    }
    np.testing.assert_allclose(frame.positions[0], [0.1, 0.2, 0.3])
    np.testing.assert_allclose(np.diag(frame.cell), [10.0, 11.0, 12.0])
    assert frame.pbc == (True, True, True)
    assert frame.scalars == {"step": 1, "energy": -1.0}


def test_extxyz_optional_arrays(tmp_path: Path) -> None:
    path = tmp_path / "run.extxyz"
    path.write_text(
        """2
Properties=species:S:1:pos:R:3:vel:R:3:forces:R:3:charge:R:1 Lattice=\"5 0 0 1 4 0 0.5 0.25 8\" pbc=\"T T F\" force_unit=eV/Angstrom
H 0 0 0 0.1 0.2 0.3 1 2 3 0.2
O 1 0 0 0.4 0.5 0.6 4 5 6 -0.2
""",
        encoding="utf-8",
    )

    dataset = PQTrajectoryDataset(path)
    frame = dataset.get_frame(0)

    np.testing.assert_allclose(frame.forces, [[1, 2, 3], [4, 5, 6]])
    np.testing.assert_allclose(frame.velocities, [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]])
    np.testing.assert_allclose(frame.charges, [0.2, -0.2])
    np.testing.assert_allclose(
        frame.cell,
        [[5, 0, 0], [1, 4, 0], [0.5, 0.25, 8]],
    )
    assert frame.pbc == (True, True, False)
    assert frame.units["forces"] == "eV/Angstrom"

    packet = encode_frame(frame)
    header_length = struct.unpack_from("<I", packet)[0]
    header = json.loads(packet[4:4 + header_length])
    assert [item["name"] for item in header["arrays"]] == [
        "positions",
        "cell",
        "forces",
        "velocities",
        "charges",
    ]
    offset = 0
    for item in header["arrays"]:
        assert item["byte_offset"] == offset
        offset += item["byte_length"]
    assert offset == header["payload_byte_length"]


def test_packet_layout(tmp_path: Path) -> None:
    path = tmp_path / "water.xyz"
    path.write_text(XYZ, encoding="utf-8")
    packet = encode_frame(PQTrajectoryDataset(path).get_frame(0))

    header_length = struct.unpack_from("<I", packet)[0]
    header_end = 4 + header_length
    header = json.loads(packet[4:header_end])
    positions = next(item for item in header["arrays"] if item["name"] == "positions")
    start = header_end + positions["byte_offset"]
    stop = start + positions["byte_length"]

    assert header["pbc"] == [True, True, True]
    assert header["payload_byte_length"] == len(packet) - header_end
    assert positions["dtype"] == "float32"
    assert positions["byte_order"] == "little"
    decoded = np.frombuffer(packet[start:stop], dtype="<f4").reshape(
        positions["shape"]
    )
    np.testing.assert_allclose(decoded, [[0, 0, 0], [1, 0, 0]])


def test_refresh_waits_for_complete_frame(tmp_path: Path) -> None:
    path = tmp_path / "growing.xyz"
    second_frame = XYZ.find("2 10 11 12\n", 1)
    path.write_text(XYZ[:second_frame], encoding="utf-8")
    dataset = PQTrajectoryDataset(path)

    with path.open("a", encoding="utf-8") as handle:
        handle.write("2\nstep=1\nH 0.1 0.0 0.0\n")
    assert dataset.refresh() == 0
    assert dataset.frame_count == 1

    with path.open("a", encoding="utf-8") as handle:
        handle.write("O 1.1 0.0 0.0\n")
    assert dataset.refresh() == 1
    assert dataset.frame_count == 2
    np.testing.assert_allclose(dataset.get_frame(1).positions[1], [1.1, 0, 0])


def test_frame_inherits_the_last_declared_cell(tmp_path: Path) -> None:
    path = tmp_path / "cell.xyz"
    path.write_text(
        """1 8 9 10 90 90 75
first
H 0 0 0
1
second
H 1 2 3
""",
        encoding="utf-8",
    )
    dataset = PQTrajectoryDataset(path)

    np.testing.assert_allclose(dataset.get_frame(1).cell, dataset.get_frame(0).cell)
    assert dataset.get_frame(1).pbc == (True, True, True)


def test_energy_sidecar_preserves_labels_and_units(tmp_path: Path) -> None:
    trajectory = tmp_path / "water.xyz"
    trajectory.write_text(XYZ, encoding="utf-8")
    energy = tmp_path / "water.en"
    energy.write_text("0 -1.5\n1 -1.0\n", encoding="utf-8")
    info = tmp_path / "water.info"
    info.write_text(
        """--------------------------------
| PQ info file |
--------------------------------
| SIMULATION-TIME 0.0 ps E(TOT) -1.5 kcal/mol |
--------------------------------

""",
        encoding="utf-8",
    )

    dataset = PQTrajectoryDataset(
        trajectory,
        energy_path=energy,
        info_path=info,
    )
    series = dataset.manifest()["series"]

    assert series[0] == {
        "name": "simulation_time",
        "label": "SIMULATION-TIME",
        "unit": "ps",
        "values": [0.0, 1.0],
    }
    assert series[1] == {
        "name": "e_tot",
        "label": "E(TOT)",
        "unit": "kcal/mol",
        "values": [-1.5, -1.0],
    }
    assert dataset.get_frame(1).scalars["e_tot"] == -1.0


def test_empty_file_can_grow_into_extxyz(tmp_path: Path) -> None:
    path = tmp_path / "growing.xyz"
    path.write_text("", encoding="utf-8")
    dataset = PQTrajectoryDataset(path)

    assert dataset.manifest()["frame_count"] == 0
    with pytest.raises(IndexError):
        dataset.get_frame(0)

    path.write_text(
        """1
Properties=species:S:1:pos:R:3:forces:R:3
H 0 0 0 1 2 3
""",
        encoding="utf-8",
    )
    assert dataset.refresh() == 1
    np.testing.assert_allclose(dataset.get_frame(0).forces, [[1, 2, 3]])


def test_refresh_reindexes_after_truncation(tmp_path: Path) -> None:
    path = tmp_path / "run.xyz"
    path.write_text(XYZ, encoding="utf-8")
    dataset = PQTrajectoryDataset(path)
    second_frame = XYZ.find("2 10 11 12\n", 1)

    path.write_text(XYZ[:second_frame], encoding="utf-8")

    assert dataset.refresh() == 0
    assert dataset.frame_count == 1
    np.testing.assert_allclose(dataset.get_frame(0).positions[1], [1, 0, 0])


def test_refresh_detects_a_longer_in_place_rewrite(tmp_path: Path) -> None:
    path = tmp_path / "run.xyz"
    path.write_text(XYZ, encoding="utf-8")
    dataset = PQTrajectoryDataset(path)
    rewritten = """2 20 21 22
rewritten_with_a_comment_that_is_longer_than_the_original_file=""" + "x" * 200 + """
H 3 2 1
O 4 5 6
"""

    path.write_text(rewritten, encoding="utf-8")

    assert dataset.refresh() == 0
    assert dataset.frame_count == 1
    np.testing.assert_allclose(dataset.get_frame(0).positions[0], [3, 2, 1])


def test_manifest_discovers_later_extxyz_arrays(tmp_path: Path) -> None:
    path = tmp_path / "varying.extxyz"
    path.write_text(
        """1
Properties=species:S:1:pos:R:3
H 0 0 0
1
Properties=species:S:1:pos:R:3:forces:R:3 force_units=eV/Angstrom
H 0.1 0 0 1 2 3
""",
        encoding="utf-8",
    )
    dataset = PQTrajectoryDataset(path)

    assert dataset.manifest()["properties"]["forces"]["unit"] == "eV/Angstrom"
    np.testing.assert_allclose(dataset.get_frame(1).forces, [[1, 2, 3]])


def test_provided_topology_is_normalized_for_browser_indices(tmp_path: Path) -> None:
    path = tmp_path / "bonded.xyz"
    path.write_text(XYZ[: XYZ.find("2 10 11 12\n", 1)], encoding="utf-8")
    topology = Topology(
        atoms=[Atom("H"), Atom("O")],
        bonded_topology=BondedTopology(bonds=[Bond(1, 2)]),
    )

    manifest = PQTrajectoryDataset(path, topology=topology).manifest()

    assert manifest["topology"]["bonds"] == [[0, 1]]
