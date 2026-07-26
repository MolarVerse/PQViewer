"""Exact display coordinates from PQAnalysis cell geometry.

Cell.image uses round-to-even and all three axes. These helpers keep PQ's
half-open convention and the viewer's per-axis PBC contract.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from PQAnalysis.core import Cell


_INT32_MIN = np.iinfo(np.int32).min
_INT32_MAX = np.iinfo(np.int32).max


def fractional_coordinates(cell: Cell, positions: np.ndarray) -> np.ndarray:
    """Return fractional coordinates without changing the input."""
    values = _positions(positions)
    if cell.is_vacuum:
        raise ValueError("fractional coordinates require a finite cell")
    if cell.alpha == 90 and cell.beta == 90 and cell.gamma == 90:
        return values / np.asarray(cell.box_lengths, dtype=np.float64)
    return values @ np.asarray(cell.inverse_box_matrix, dtype=np.float64).T


def centered_image_shifts(
    cell: Cell,
    positions: np.ndarray,
    pbc: Sequence[bool],
    *,
    origin: Sequence[float] = (0.0, 0.0, 0.0),
) -> np.ndarray:
    """Return lattice shifts into [origin - 0.5, origin + 0.5)."""
    values = _positions(positions)
    periodic = _pbc(pbc)
    if not any(periodic):
        return np.zeros(values.shape, dtype=np.int32)
    if cell.is_vacuum:
        raise ValueError("periodic coordinates require a finite cell")

    center = np.asarray(origin, dtype=np.float64)
    if center.shape != (3,) or not np.all(np.isfinite(center)):
        raise ValueError("origin must contain three finite values")

    fractional = fractional_coordinates(cell, values)
    shifts = np.zeros(values.shape, dtype=np.int64)
    for axis, enabled in enumerate(periodic):
        if enabled:
            shifts[:, axis] = -_centered_lattice_index(
                fractional[:, axis] - center[axis]
            )
    return _as_int32(shifts)


def apply_image_shifts(
    cell: Cell,
    positions: np.ndarray,
    shifts: np.ndarray,
) -> np.ndarray:
    """Apply integer lattice shifts without changing the source coordinates."""
    values = _positions(positions)
    lattice_shifts = np.asarray(shifts)
    if lattice_shifts.shape != values.shape:
        raise ValueError("shifts must match the position shape")
    if not np.issubdtype(lattice_shifts.dtype, np.integer):
        raise TypeError("shifts must be integers")
    if cell.is_vacuum:
        if np.any(lattice_shifts):
            raise ValueError("nonzero shifts require a finite cell")
        return values.copy()
    basis = np.asarray(cell.box_matrix, dtype=np.float64).T
    return values + lattice_shifts.astype(np.float64) @ basis


def centered_wrap(
    cell: Cell,
    positions: np.ndarray,
    pbc: Sequence[bool],
    *,
    origin: Sequence[float] = (0.0, 0.0, 0.0),
) -> tuple[np.ndarray, np.ndarray]:
    """Wrap coordinates and return the applied integer lattice shifts."""
    shifts = centered_image_shifts(cell, positions, pbc, origin=origin)
    return apply_image_shifts(cell, positions, shifts), shifts


def unwrap_image_step(
    previous_cell: Cell,
    previous_positions: np.ndarray,
    current_cell: Cell,
    current_positions: np.ndarray,
    current_pbc: Sequence[bool],
    previous_shifts: np.ndarray,
) -> np.ndarray:
    """Advance exact unwrapped image shifts by one trajectory frame."""
    previous = _positions(previous_positions)
    current = _positions(current_positions)
    if previous.shape != current.shape:
        raise ValueError("trajectory topology changed")

    shifts = np.asarray(previous_shifts)
    if shifts.shape != current.shape or not np.issubdtype(shifts.dtype, np.integer):
        raise ValueError("previous shifts must be an integer position array")
    periodic = _pbc(current_pbc)
    if not any(periodic):
        return np.zeros(current.shape, dtype=np.int64)
    if previous_cell.is_vacuum or current_cell.is_vacuum:
        raise ValueError("periodic coordinates require finite adjacent cells")

    previous_fractional = fractional_coordinates(previous_cell, previous)
    current_fractional = fractional_coordinates(current_cell, current)
    result = shifts.astype(np.int64, copy=True)
    delta = current_fractional - previous_fractional
    for axis, enabled in enumerate(periodic):
        if enabled:
            result[:, axis] -= _centered_lattice_index(delta[:, axis])
        else:
            result[:, axis] = 0
    return result


def reverse_unwrap_image_step(
    previous_cell: Cell,
    previous_positions: np.ndarray,
    previous_pbc: Sequence[bool],
    current_cell: Cell,
    current_positions: np.ndarray,
    current_pbc: Sequence[bool],
    current_shifts: np.ndarray,
) -> np.ndarray:
    """Recover the previous unwrapped shifts when the step is reversible."""
    previous = _positions(previous_positions)
    current = _positions(current_positions)
    if previous.shape != current.shape:
        raise ValueError("trajectory topology changed")

    shifts = np.asarray(current_shifts)
    if shifts.shape != current.shape or not np.issubdtype(shifts.dtype, np.integer):
        raise ValueError("current shifts must be an integer position array")
    previous_periodic = _pbc(previous_pbc)
    current_periodic = _pbc(current_pbc)
    if any(
        before and not after
        for before, after in zip(previous_periodic, current_periodic, strict=True)
    ):
        raise ValueError("periodic-to-open transition is not reversible")
    if not any(current_periodic):
        return np.zeros(previous.shape, dtype=np.int64)
    if previous_cell.is_vacuum or current_cell.is_vacuum:
        raise ValueError("periodic coordinates require finite adjacent cells")

    previous_fractional = fractional_coordinates(previous_cell, previous)
    current_fractional = fractional_coordinates(current_cell, current)
    result = shifts.astype(np.int64, copy=True)
    delta = current_fractional - previous_fractional
    for axis, enabled in enumerate(current_periodic):
        if enabled:
            result[:, axis] += _centered_lattice_index(delta[:, axis])
        else:
            result[:, axis] = 0
    return result


def checked_int32(values: np.ndarray) -> np.ndarray:
    """Return an exact little-range integer array for frame packets."""
    array = np.asarray(values)
    if not np.issubdtype(array.dtype, np.integer):
        raise TypeError("image shifts must be integers")
    return _as_int32(array)


def _positions(positions: np.ndarray) -> np.ndarray:
    values = np.asarray(positions, dtype=np.float64)
    if values.ndim != 2 or values.shape[1] != 3:
        raise ValueError("positions must have shape (atoms, 3)")
    if not np.all(np.isfinite(values)):
        raise ValueError("positions must be finite")
    return values


def _pbc(pbc: Sequence[bool]) -> tuple[bool, bool, bool]:
    values = tuple(bool(value) for value in pbc)
    if len(values) != 3:
        raise ValueError("pbc must contain three flags")
    return values


def _as_int32(values: np.ndarray) -> np.ndarray:
    if np.any(values < _INT32_MIN) or np.any(values > _INT32_MAX):
        raise OverflowError("image shift exceeds int32")
    return np.ascontiguousarray(values, dtype=np.int32)


def _centered_lattice_index(values: np.ndarray) -> np.ndarray:
    array = np.asarray(values, dtype=np.float64)
    base = np.floor(array)
    indices = base + ((array - base) >= 0.5)
    if not np.all(np.isfinite(indices)):
        raise OverflowError("image shift exceeds int64")
    if np.any(indices < -(2**63)) or np.any(indices >= 2**63):
        raise OverflowError("image shift exceeds int64")
    return indices.astype(np.int64)
