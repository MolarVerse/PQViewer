from __future__ import annotations

import json
from pathlib import Path
import struct

import numpy as np
import pytest

from PQAnalysis.core import Cell

from pqviewer.data import PQTrajectoryDataset
from pqviewer.packet import encode_frame
from pqviewer.periodic import (
    apply_image_shifts,
    centered_image_shifts,
    centered_wrap,
    reverse_unwrap_image_step,
    unwrap_image_step,
)


def test_unwrap_restarts_across_a_vacuum_boundary() -> None:
    previous = np.array([[0.0, 0.0, 0.0]])
    current = np.array([[4.8, 0.0, 0.0]])
    shifts = unwrap_image_step(
        Cell(),
        previous,
        Cell(10, 10, 10),
        current,
        (True, True, True),
        np.array([[3, 0, 0]], dtype=np.int64),
    )
    np.testing.assert_array_equal(shifts, [[0, 0, 0]])

    reverse = reverse_unwrap_image_step(
        Cell(),
        previous,
        (False, False, False),
        Cell(10, 10, 10),
        current,
        (True, True, True),
        np.array([[2, 0, 0]], dtype=np.int64),
    )
    np.testing.assert_array_equal(reverse, [[0, 0, 0]])


def test_centered_wrap_uses_half_open_bounds_and_partial_pbc() -> None:
    cell = Cell(10, 20, 30)
    fractional = np.array([
        [0.5, -0.5, 1.5],
        [-0.5, 0.5, -1.5],
        [0.75, 2.0, -0.75],
    ])
    positions = fractional * np.asarray(cell.box_lengths)
    source = positions.copy()

    wrapped, shifts = centered_wrap(cell, positions, (True, False, True))

    np.testing.assert_array_equal(
        shifts,
        [[-1, 0, -2], [0, 0, 1], [-1, 0, 1]],
    )
    np.testing.assert_allclose(
        wrapped,
        (fractional + shifts) @ cell.box_matrix.T,
    )
    np.testing.assert_array_equal(positions, source)
    assert shifts.dtype == np.int32


def test_centered_wrap_preserves_values_adjacent_to_half_cell_bounds() -> None:
    cell = Cell(1, 1, 1)
    fractional = np.array([
        [np.nextafter(0.5, -np.inf), 0.5, np.nextafter(0.5, np.inf)],
        [np.nextafter(-0.5, -np.inf), -0.5, np.nextafter(-0.5, np.inf)],
    ])
    positions = fractional.copy()

    _, shifts = centered_wrap(cell, positions, (True, True, True))

    np.testing.assert_array_equal(
        shifts,
        [[0, -1, -1], [1, 0, 0]],
    )


def test_centered_wrap_respects_a_triclinic_origin() -> None:
    cell = Cell(8, 9, 10, 80, 95, 75)
    origin = np.array([0.25, -0.25, 0.0])
    fractional = np.array([
        [0.76, 0.26, 0.51],
        [-0.24, -0.74, -0.49],
        [1.6, -1.8, 0.2],
    ])
    positions = fractional @ cell.box_matrix.T

    wrapped, shifts = centered_wrap(
        cell,
        positions,
        (True, True, True),
        origin=origin,
    )
    wrapped_fractional = fractional + shifts

    np.testing.assert_allclose(
        wrapped,
        wrapped_fractional @ cell.box_matrix.T,
        atol=1e-12,
    )
    assert np.all(wrapped_fractional >= origin - 0.5 - 1e-12)
    assert np.all(wrapped_fractional < origin + 0.5 + 1e-12)
    np.testing.assert_array_equal(shifts[:2], [[-1, -1, -1], [0, 0, 0]])


def test_centered_shift_validation_is_explicit() -> None:
    cell = Cell(10, 10, 10)
    positions = np.zeros((1, 3))

    with pytest.raises(ValueError, match="pbc"):
        centered_image_shifts(cell, positions, (True, True))
    with pytest.raises(ValueError, match="origin"):
        centered_image_shifts(
            cell,
            positions,
            (True, True, True),
            origin=(0, float("nan"), 0),
        )
    with pytest.raises(OverflowError, match="int32"):
        centered_image_shifts(
            cell,
            np.array([[float(2**31 + 1) * 10, 0, 0]]),
            (True, False, False),
        )


def test_unwrap_step_tracks_triclinic_crossings_on_two_axes() -> None:
    previous_cell = Cell(8, 9, 10, 80, 95, 75)
    current_cell = Cell(8.5, 9.5, 11, 82, 93, 72)
    previous_fractional = np.array([
        [0.49, 0.2, 0.49],
        [-0.48, -0.4, -0.47],
    ])
    current_fractional = np.array([
        [-0.49, 0.9, -0.48],
        [0.49, 0.45, 0.48],
    ])
    previous_positions = previous_fractional @ previous_cell.box_matrix.T
    current_positions = current_fractional @ current_cell.box_matrix.T

    shifts = unwrap_image_step(
        previous_cell,
        previous_positions,
        current_cell,
        current_positions,
        (True, False, True),
        np.zeros((2, 3), dtype=np.int64),
    )
    unwrapped = apply_image_shifts(current_cell, current_positions, shifts)

    np.testing.assert_array_equal(shifts, [[1, 0, 1], [-1, 0, -1]])
    np.testing.assert_allclose(
        unwrapped,
        (current_fractional + shifts) @ current_cell.box_matrix.T,
        atol=1e-12,
    )


def test_reverse_unwrap_step_recovers_previous_shifts() -> None:
    previous_cell = Cell(8, 9, 10, 80, 95, 75)
    current_cell = Cell(8.5, 9.5, 11, 82, 93, 72)
    previous_fractional = np.array([
        [0.49, 0.2, 0.49],
        [-0.48, -0.4, -0.47],
    ])
    current_fractional = np.array([
        [-0.49, 0.9, -0.48],
        [0.49, 0.45, 0.48],
    ])
    previous_positions = previous_fractional @ previous_cell.box_matrix.T
    current_positions = current_fractional @ current_cell.box_matrix.T
    previous_shifts = np.array([[3, 0, -2], [-4, 0, 5]], dtype=np.int64)
    current_shifts = unwrap_image_step(
        previous_cell,
        previous_positions,
        current_cell,
        current_positions,
        (True, False, True),
        previous_shifts,
    )

    recovered = reverse_unwrap_image_step(
        previous_cell,
        previous_positions,
        (True, False, True),
        current_cell,
        current_positions,
        (True, False, True),
        current_shifts,
    )

    np.testing.assert_array_equal(recovered, previous_shifts)


def test_reverse_unwrap_step_rejects_periodic_to_open_transition() -> None:
    cell = Cell(10, 10, 10)
    with pytest.raises(ValueError, match="not reversible"):
        reverse_unwrap_image_step(
            cell,
            np.array([[4.9, 0.0, 0.0]]),
            (True, False, False),
            cell,
            np.array([[0.0, 0.0, 0.0]]),
            (False, False, False),
            np.zeros((1, 3), dtype=np.int64),
        )


def test_unwrapped_coordinates_are_seek_order_independent(tmp_path: Path) -> None:
    path = tmp_path / "variable-cell.extxyz"
    path.write_text(
        _trajectory([
            ((10, 10, 10), (4.9, 2.0, 4.9)),
            ((12, 11, 12), (-5.88, 8.0, -5.88)),
            ((14, 9, 14), (-6.3, -7.0, -6.3)),
            ((16, 13, 16), (7.68, 3.0, 7.68)),
        ]),
        encoding="utf-8",
    )
    dataset = PQTrajectoryDataset(path)
    expected = np.array([
        [4.9, 2.0, 4.9],
        [6.12, 8.0, 6.12],
        [7.7, -7.0, 7.7],
        [7.68, 3.0, 7.68],
    ])
    source = [dataset.get_frame(index).positions.copy() for index in range(4)]

    for index in [3, 0, 2, 1, 3, 2]:
        frame = dataset.get_frame(index, coordinates="unwrapped")
        np.testing.assert_allclose(frame.positions, source[index])
        np.testing.assert_allclose(frame.unwrapped_positions[0], expected[index])
        assert frame.coordinates == "unwrapped"
        assert frame.unwrapped_image_shifts.dtype == np.int32
        assert frame.unwrapped_image_shifts[0, 1] == 0

    np.testing.assert_array_equal(
        dataset.get_frame(1, coordinates="unwrapped").unwrapped_image_shifts,
        [[1, 0, 1]],
    )
    for index in range(4):
        np.testing.assert_allclose(dataset.get_frame(index).positions, source[index])


def test_reverse_seek_reconstructs_the_same_unwrapped_branch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "reverse.extxyz"
    path.write_text(
        _trajectory([
            ((10, 10, 10), (4.9, 0.0, 0.0)),
            ((10, 10, 10), (-4.9, 0.0, 0.0)),
            ((10, 10, 10), (-4.7, 0.0, 0.0)),
            ((10, 10, 10), (-4.5, 0.0, 0.0)),
        ]),
        encoding="utf-8",
    )
    dataset = PQTrajectoryDataset(path)
    dataset.UNWRAP_CACHE_SIZE = 1
    source_reads: list[int] = []
    get_source_frame = dataset._get_source_frame

    def traced_get_source_frame(index: int):
        source_reads.append(index)
        return get_source_frame(index)

    monkeypatch.setattr(dataset, "_get_source_frame", traced_get_source_frame)

    np.testing.assert_allclose(
        dataset.get_frame(3, coordinates="unwrapped").unwrapped_positions[0, 0],
        5.5,
    )
    assert list(dataset._unwrapped_cache) == [3]
    source_reads.clear()
    np.testing.assert_allclose(
        dataset.get_frame(1, coordinates="unwrapped").unwrapped_positions[0, 0],
        5.1,
    )
    assert list(dataset._unwrapped_cache) == [1]
    assert source_reads == [1, 2]


def test_reverse_seek_uses_a_prior_anchor_when_pbc_changes(tmp_path: Path) -> None:
    path = tmp_path / "changing-pbc.extxyz"
    positions = [4.9, -4.9, -4.7, -4.5, -4.3, 0.0]
    chunks = []
    for index, position in enumerate(positions):
        periodic = "T F F" if index < 5 else "F F F"
        chunks.append(
            "1\n"
            "Properties=species:S:1:pos:R:3 "
            f'Lattice="10 0 0 0 10 0 0 0 10" pbc="{periodic}"\n'
            f"H {position} 0 0\n"
        )
    path.write_text("".join(chunks), encoding="utf-8")
    dataset = PQTrajectoryDataset(path)
    dataset.get_frame(5, coordinates="unwrapped")

    frame = dataset.get_frame(4, coordinates="unwrapped")
    expected = PQTrajectoryDataset(path).get_frame(4, coordinates="unwrapped")

    np.testing.assert_allclose(
        frame.unwrapped_positions,
        expected.unwrapped_positions,
    )
    np.testing.assert_allclose(frame.unwrapped_positions[0, 0], 5.7)


def test_unwrap_cache_is_frame_and_byte_bounded(tmp_path: Path) -> None:
    path = tmp_path / "long.extxyz"
    frames = []
    for index in range(40):
        fractional = ((0.45 + index * 0.08 + 0.5) % 1.0) - 0.5
        frames.append(((10, 10, 10), (fractional * 10, 0.0, 0.0)))
    path.write_text(_trajectory(frames), encoding="utf-8")
    dataset = PQTrajectoryDataset(path)
    dataset.UNWRAP_CACHE_BYTES = 250

    for index in range(40):
        dataset.get_frame(index, coordinates="unwrapped")

    assert len(dataset._unwrapped_cache) <= dataset.UNWRAP_CACHE_SIZE
    assert dataset._unwrapped_cache_bytes <= dataset.UNWRAP_CACHE_BYTES


def test_unwrap_cache_keeps_seek_endpoints(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "seeks.extxyz"
    frames = [
        (
            (10, 10, 10),
            (
                ((((0.45 + index * 0.08) + 0.5) % 1.0) - 0.5) * 10,
                0.0,
                0.0,
            ),
        )
        for index in range(80)
    ]
    path.write_text(_trajectory(frames), encoding="utf-8")
    dataset = PQTrajectoryDataset(path)
    source_reads: list[int] = []
    get_source_frame = dataset._get_source_frame

    def traced_get_source_frame(index: int):
        source_reads.append(index)
        return get_source_frame(index)

    monkeypatch.setattr(dataset, "_get_source_frame", traced_get_source_frame)
    dataset.get_frame(79, coordinates="unwrapped")
    first_seek_reads = len(source_reads)
    dataset.get_frame(0, coordinates="unwrapped")
    dataset.get_frame(79, coordinates="unwrapped")

    assert first_seek_reads == 80
    assert len(source_reads) == first_seek_reads + 2
    assert {0, 79}.issubset(dataset._unwrapped_cache)


def test_reindexed_trajectory_clears_unwrap_anchors(tmp_path: Path) -> None:
    path = tmp_path / "replaced.extxyz"
    path.write_text(
        _trajectory([
            ((10, 10, 10), (4.9, 0.0, 0.0)),
            ((10, 10, 10), (-4.9, 0.0, 0.0)),
        ]),
        encoding="utf-8",
    )
    dataset = PQTrajectoryDataset(path)
    dataset.get_frame(1, coordinates="unwrapped")
    assert dataset._unwrapped_cache

    path.write_text(
        _trajectory([((8, 8, 8), (0.0, 0.0, 0.0))]),
        encoding="utf-8",
    )
    dataset.refresh()

    assert not dataset._unwrapped_cache
    assert dataset._unwrapped_cache_bytes == 0


def test_same_size_rewrite_clears_unwrap_anchors(tmp_path: Path) -> None:
    path = tmp_path / "rewritten.extxyz"
    frames = [((10, 10, 10), (4.9, 0.0, 0.0))]
    frames.extend(
        ((10, 10, 10), (-4.9 + index * 0.01, 0.0, 0.0))
        for index in range(20)
    )
    original = _trajectory(frames)
    path.write_text(original, encoding="utf-8")
    dataset = PQTrajectoryDataset(path)
    dataset.get_frame(20, coordinates="unwrapped")

    rewritten = original.replace("H 4.9 0 0", "H 0.0 0 0", 1)
    assert len(rewritten) == len(original)
    path.write_text(rewritten, encoding="utf-8")
    dataset.refresh()

    refreshed = dataset.get_frame(20, coordinates="unwrapped")
    expected = PQTrajectoryDataset(path).get_frame(20, coordinates="unwrapped")
    np.testing.assert_allclose(
        refreshed.unwrapped_positions,
        expected.unwrapped_positions,
    )


def test_packet_keeps_source_and_exact_image_shifts(tmp_path: Path) -> None:
    path = tmp_path / "packet.extxyz"
    path.write_text(
        _trajectory([
            ((10, 10, 10), (4.9, 0.0, 0.0)),
            ((10, 10, 10), (-4.9, 0.0, 0.0)),
        ]),
        encoding="utf-8",
    )
    frame = PQTrajectoryDataset(path).get_frame(1, coordinates="unwrapped")
    packet = encode_frame(frame)
    header_size = struct.unpack_from("<I", packet)[0]
    header_end = 4 + header_size
    header = json.loads(packet[4:header_end])
    arrays = {item["name"]: item for item in header["arrays"]}

    assert header["coordinates"] == "unwrapped"
    assert arrays["positions"]["dtype"] == "float32"
    assert arrays["unwrapped_positions"]["dtype"] == "float32"
    assert arrays["centered_image_shifts"]["dtype"] == "int32"
    assert arrays["unwrapped_image_shifts"]["dtype"] == "int32"
    np.testing.assert_allclose(
        _packet_array(packet, header_end, arrays["positions"]),
        [[-4.9, 0.0, 0.0]],
    )
    np.testing.assert_array_equal(
        _packet_array(packet, header_end, arrays["unwrapped_image_shifts"]),
        [[1, 0, 0]],
    )


def _trajectory(
    frames: list[
        tuple[tuple[float, float, float], tuple[float, float, float]]
    ],
) -> str:
    chunks = []
    for lengths, position in frames:
        x, y, z = lengths
        px, py, pz = position
        chunks.append(
            "1\n"
            "Properties=species:S:1:pos:R:3 "
            f'Lattice="{x} 0 0 0 {y} 0 0 0 {z}" pbc="T F T"\n'
            f"H {px:.15g} {py:.15g} {pz:.15g}\n"
        )
    return "".join(chunks)


def _packet_array(
    packet: bytes,
    header_end: int,
    descriptor: dict[str, object],
) -> np.ndarray:
    start = header_end + int(descriptor["byte_offset"])
    stop = start + int(descriptor["byte_length"])
    dtype = "<i4" if descriptor["dtype"] == "int32" else "<f4"
    return np.frombuffer(packet[start:stop], dtype=dtype).reshape(
        descriptor["shape"]
    )
