from __future__ import annotations

import json
from pathlib import Path
import struct

import numpy as np
import pytest

from PQAnalysis.core import Atom, Residue
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

FORCES = """2 10 11 12
0.0 0.0 0.0
H 1.0 2.0 3.0
O 4.0 5.0 6.0
2 10 11 12
0.0 0.0 0.0
H 7.0 8.0 9.0
O 10.0 11.0 12.0
"""

WATER_DIMER = """6 10 10 10
water dimer
O 0.0 0.0 0.0
H 1.0 0.0 0.0
H 0.0 1.0 0.0
O 3.0 0.0 0.0
H 4.0 0.0 0.0
H 3.0 1.0 0.0
"""

MOLDESCRIPTOR = """WATER_TYPE 1
H2O 3 0.0
O 0 -0.65966
H 1 0.32983
H 1 0.32983
"""

SHAKE_TOPOLOGY = """SHAKE
1 2 1
1 3 1
4 5 1
4 6 1
END
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
        "atom_residue_index": [-1, -1],
        "residues": [],
        "bonds": [],
        "bond_source": "inferred",
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


def test_auto_detects_pq_force_companion(tmp_path: Path) -> None:
    trajectory = tmp_path / "water.xyz"
    trajectory.write_text(XYZ, encoding="utf-8")
    forces = tmp_path / "water.force"
    forces.write_text(FORCES, encoding="utf-8")

    dataset = PQTrajectoryDataset(trajectory)
    manifest = dataset.manifest()
    frame = dataset.get_frame(1)

    np.testing.assert_allclose(frame.forces, [[7, 8, 9], [10, 11, 12]])
    assert frame.units["forces"] == "kcal/(mol Å)"
    assert manifest["properties"]["forces"]["unit"] == "kcal/(mol Å)"
    assert manifest["companion_files"]["forces"] == {
        "available": True,
        "frame_count": 2,
        "file": "water.force",
        "alignment": "frame_index",
        "complete": True,
    }
    assert manifest["companion_files"]["velocities"]["available"] is False


def test_does_not_guess_between_companion_candidates(tmp_path: Path) -> None:
    trajectory = tmp_path / "water.xyz"
    trajectory.write_text(XYZ, encoding="utf-8")
    (tmp_path / "water.force").write_text(FORCES, encoding="utf-8")
    (tmp_path / "water.frc").write_text(FORCES, encoding="utf-8")

    manifest = PQTrajectoryDataset(trajectory).manifest()

    assert manifest["companion_files"]["forces"]["available"] is False
    assert "forces" not in manifest["properties"]


def test_embedded_arrays_win_unless_companion_is_explicit(tmp_path: Path) -> None:
    trajectory = tmp_path / "run.extxyz"
    trajectory.write_text(
        """1
Properties=species:S:1:pos:R:3:forces:R:3 force_unit=eV/Angstrom
H 0 0 0 1 2 3
""",
        encoding="utf-8",
    )
    auto_forces = tmp_path / "run.force"
    auto_forces.write_text("1\n\nH 4 5 6\n", encoding="utf-8")
    selected_forces = tmp_path / "selected.force"
    selected_forces.write_text("1\n\nH 7 8 9\n", encoding="utf-8")

    automatic = PQTrajectoryDataset(trajectory).get_frame(0)
    explicit = PQTrajectoryDataset(
        trajectory,
        forces_path=selected_forces,
    ).get_frame(0)

    np.testing.assert_allclose(automatic.forces, [[1, 2, 3]])
    assert automatic.units["forces"] == "eV/Angstrom"
    np.testing.assert_allclose(explicit.forces, [[7, 8, 9]])
    assert explicit.units["forces"] == "kcal/(mol Å)"


def test_explicit_pq_companions_merge_by_frame(tmp_path: Path) -> None:
    trajectory = tmp_path / "water.xyz"
    trajectory.write_text(XYZ, encoding="utf-8")
    forces = tmp_path / "vectors.dat"
    velocities = tmp_path / "speeds.dat"
    charges = tmp_path / "charges.dat"
    forces.write_text(FORCES, encoding="utf-8")
    velocities.write_text(FORCES, encoding="utf-8")
    charges.write_text(
        """2

H 0.25
O -0.25
2

H 0.3
O -0.3
""",
        encoding="utf-8",
    )

    frame = PQTrajectoryDataset(
        trajectory,
        forces_path=forces,
        velocities_path=velocities,
        charges_path=charges,
    ).get_frame(1)

    np.testing.assert_allclose(frame.forces[0], [7, 8, 9])
    np.testing.assert_allclose(frame.velocities[1], [10, 11, 12])
    np.testing.assert_allclose(frame.charges, [0.3, -0.3])
    assert frame.units["velocities"] == "Å/s"
    assert frame.units["charges"] == "e"


def test_companion_validates_atom_count(tmp_path: Path) -> None:
    trajectory = tmp_path / "water.xyz"
    trajectory.write_text(XYZ, encoding="utf-8")
    forces = tmp_path / "water.force"
    forces.write_text("1\n\nH 1 2 3\n", encoding="utf-8")

    with pytest.raises(ValueError, match="force frame 0 has 1 atoms"):
        PQTrajectoryDataset(trajectory).manifest()


def test_companion_validates_atom_order(tmp_path: Path) -> None:
    trajectory = tmp_path / "water.xyz"
    trajectory.write_text(XYZ, encoding="utf-8")
    forces = tmp_path / "water.force"
    forces.write_text(
        "2\n\nO 1 2 3\nH 4 5 6\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="force frame 0 atom 0 is O"):
        PQTrajectoryDataset(trajectory).manifest()


def test_refresh_indexes_a_completed_companion_frame(tmp_path: Path) -> None:
    trajectory = tmp_path / "water.xyz"
    trajectory.write_text(XYZ, encoding="utf-8")
    forces = tmp_path / "water.force"
    second_frame = FORCES.find("2 10 11 12\n", 1)
    forces.write_text(FORCES[:second_frame], encoding="utf-8")
    dataset = PQTrajectoryDataset(trajectory)

    assert dataset.get_frame(1).forces is None
    with forces.open("a", encoding="utf-8") as handle:
        handle.write(FORCES[second_frame:])

    assert dataset.refresh() == 0
    np.testing.assert_allclose(dataset.get_frame(1).forces[0], [7, 8, 9])


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


def test_frame_inherits_partial_pbc_with_the_declared_cell(tmp_path: Path) -> None:
    path = tmp_path / "cell.extxyz"
    path.write_text(
        """1
Properties=species:S:1:pos:R:3 Lattice="5 0 0 1 4 0 0 0 8" pbc="T F T"
H 0 0 0
1
Properties=species:S:1:pos:R:3
H 1 2 3
""",
        encoding="utf-8",
    )
    dataset = PQTrajectoryDataset(path)

    np.testing.assert_allclose(dataset.get_frame(1).cell, dataset.get_frame(0).cell)
    assert dataset.get_frame(1).pbc == (True, False, True)


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
    assert manifest["topology"]["bond_source"] == "topology"


def test_moldescriptor_builds_repeated_semantic_residues(tmp_path: Path) -> None:
    trajectory = tmp_path / "water.xyz"
    moldescriptor = tmp_path / "moldescriptor.dat"
    topology = tmp_path / "topology.top"
    trajectory.write_text(WATER_DIMER, encoding="utf-8")
    moldescriptor.write_text(MOLDESCRIPTOR, encoding="utf-8")
    topology.write_text(SHAKE_TOPOLOGY, encoding="utf-8")

    manifest = PQTrajectoryDataset(
        trajectory,
        moldescriptor_path=moldescriptor,
        topology_path=topology,
    ).manifest()["topology"]

    assert manifest["atom_residue_index"] == [0, 0, 0, 1, 1, 1]
    assert manifest["residues"] == [
        {"index": 0, "type_id": 1, "name": "H2O", "category": "water"},
        {"index": 1, "type_id": 1, "name": "H2O", "category": "water"},
    ]
    assert manifest["bonds"] == [[0, 1], [0, 2], [3, 4], [3, 5]]
    assert manifest["bond_source"] == "topology"


def test_protein_moldescriptor_exposes_backbone_graph(tmp_path: Path) -> None:
    trajectory = tmp_path / "protein.xyz"
    moldescriptor = tmp_path / "moldescriptor.dat"
    topology = tmp_path / "protein.top"
    atoms = ["N", "C", "C", "O"] * 3
    trajectory.write_text(
        f"{len(atoms)}\n\n" + "".join(
            f"{name} {index} 0 0\n" for index, name in enumerate(atoms)
        ),
        encoding="utf-8",
    )
    moldescriptor.write_text(
        """ALA 4 0.0
N 0 0.0
C 0 0.0
C 0 0.0
O 0 0.0
""",
        encoding="utf-8",
    )
    topology.write_text(
        """BONDS
1 2 1
2 3 1
3 4 1
3 5 1
5 6 1
6 7 1
7 8 1
7 9 1
9 10 1
10 11 1
11 12 1
END
""",
        encoding="utf-8",
    )

    manifest = PQTrajectoryDataset(
        trajectory,
        moldescriptor_path=moldescriptor,
        topology_path=topology,
    ).manifest()["topology"]

    assert manifest["atom_names"] == atoms
    assert manifest["atom_residue_index"] == [0] * 4 + [1] * 4 + [2] * 4
    assert [residue["category"] for residue in manifest["residues"]] == [
        "amino-acid",
        "amino-acid",
        "amino-acid",
    ]
    assert [2, 4] in manifest["bonds"]
    assert [6, 8] in manifest["bonds"]


def test_moldescriptor_requires_a_contiguous_element_match(tmp_path: Path) -> None:
    trajectory = tmp_path / "water.xyz"
    moldescriptor = tmp_path / "moldescriptor.dat"
    trajectory.write_text("3\n\nO 0 0 0\nH 1 0 0\nO 0 1 0\n", encoding="utf-8")
    moldescriptor.write_text(MOLDESCRIPTOR, encoding="utf-8")

    with pytest.raises(ValueError, match="atom index 0"):
        PQTrajectoryDataset(
            trajectory,
            moldescriptor_path=moldescriptor,
        ).manifest()


def test_water_category_uses_exact_residue_composition(tmp_path: Path) -> None:
    trajectory = tmp_path / "solvent.xyz"
    trajectory.write_text(
        "7\n\nO 0 0 0\nH 1 0 0\nH 0 1 0\nO 3 0 0\nH 4 0 0\nH 3 1 0\nH 3 0 1\n",
        encoding="utf-8",
    )
    water = Residue("SOL", 4, 0, ["O", "H", "H"], np.array([0, 1, 1]), np.zeros(3))
    other = Residue(
        "SOL4",
        5,
        0,
        ["O", "H", "H", "H"],
        np.array([0, 1, 1, 1]),
        np.zeros(4),
    )
    topology = Topology(
        atoms=[Atom(name) for name in ["O", "H", "H", "O", "H", "H", "H"]],
        residue_ids=np.array([4, 4, 4, 5, 5, 5, 5]),
        reference_residues=[water, other],
    )

    residues = PQTrajectoryDataset(
        trajectory,
        topology=topology,
    ).manifest()["topology"]["residues"]

    assert [residue["category"] for residue in residues] == ["water", "other"]


def test_manifest_classifies_common_biopolymer_residue_names(
    tmp_path: Path,
) -> None:
    trajectory = tmp_path / "biopolymer.xyz"
    amino_acids = [
        "ALA",
        "ARG",
        "ASN",
        "ASP",
        "CYS",
        "GLN",
        "GLU",
        "GLY",
        "HIS",
        "ILE",
        "LEU",
        "LYS",
        "MET",
        "PHE",
        "PRO",
        "SER",
        "THR",
        "TRP",
        "TYR",
        "VAL",
        "HIE",
        "NALA",
    ]
    nucleotides = ["DA5", "U", "URA"]
    names = ["HOH", *amino_acids, *nucleotides, "LIG"]
    trajectory.write_text(
        f"{len(names)}\n\n" + "".join("C 0 0 0\n" for _ in names),
        encoding="utf-8",
    )
    reference_residues = [
        Residue(name, index, 0, ["C"], np.array([0]), np.zeros(1))
        for index, name in enumerate(names, start=1)
    ]
    topology = Topology(
        atoms=[Atom("C") for _ in names],
        residue_ids=np.arange(1, len(names) + 1),
        reference_residues=reference_residues,
    )

    residues = PQTrajectoryDataset(
        trajectory,
        topology=topology,
    ).manifest()["topology"]["residues"]
    categories = {residue["name"]: residue["category"] for residue in residues}

    assert categories["HOH"] == "water"
    assert all(categories[name] == "amino-acid" for name in amino_acids)
    assert all(categories[name] == "nucleotide" for name in nucleotides)
    assert categories["LIG"] == "other"
