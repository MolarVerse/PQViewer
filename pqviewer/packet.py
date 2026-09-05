"""Binary frame packets for the browser renderer."""

from __future__ import annotations

import json
import math
import struct
from typing import Any

import numpy as np

from .data import FrameData, SCHEMA_VERSION
from .periodic import checked_int32


def encode_frame(frame: FrameData) -> bytes:
    """Encode a frame as a JSON header followed by numeric arrays."""
    # Prefer a completed periodic cell so the viewer can build a basis and
    # apply image shifts for low-rank ASE cells.
    packet_cell = (
        frame.periodic_cell
        if frame.periodic_cell is not None
        else frame.cell
    )
    arrays = (
        ("positions", frame.positions, "float32", np.dtype("<f4")),
        ("cell", packet_cell, "float32", np.dtype("<f4")),
        ("forces", frame.forces, "float32", np.dtype("<f4")),
        ("velocities", frame.velocities, "float32", np.dtype("<f4")),
        ("charges", frame.charges, "float32", np.dtype("<f4")),
        (
            "unwrapped_positions",
            frame.unwrapped_positions,
            "float32",
            np.dtype("<f4"),
        ),
        (
            "centered_image_shifts",
            frame.centered_image_shifts,
            "int32",
            np.dtype("<i4"),
        ),
        (
            "unwrapped_image_shifts",
            frame.unwrapped_image_shifts,
            "int32",
            np.dtype("<i4"),
        ),
    )
    payload_parts: list[bytes] = []
    array_metadata: list[dict[str, Any]] = []
    offset = 0

    for name, values, dtype_name, dtype in arrays:
        if values is None:
            continue
        if dtype_name == "int32":
            values = checked_int32(values)
        array = np.ascontiguousarray(values, dtype=dtype)
        chunk = array.tobytes(order="C")
        array_metadata.append({
            "name": name,
            "dtype": dtype_name,
            "byte_order": "little",
            "shape": list(array.shape),
            "byte_offset": offset,
            "byte_length": len(chunk),
            "unit": frame.units.get(name),
        })
        payload_parts.append(chunk)
        offset += len(chunk)

    scalar_values = {
        key: _json_scalar(value) for key, value in frame.scalars.items()
    }
    header = {
        "schema_version": SCHEMA_VERSION,
        "index": frame.index,
        "coordinates": frame.coordinates,
        "pbc": list(frame.pbc),
        "scalars": scalar_values,
        "scalar_units": {
            key: frame.units.get(key) for key in frame.scalars
        },
        "arrays": array_metadata,
        "payload_byte_length": offset,
    }
    if frame.frame_key is not None:
        header["frame_key"] = {
            "source_id": frame.frame_key.source_id,
            "source_index": frame.frame_key.source_index,
            "segment_index": frame.frame_key.segment_index,
            "step": frame.frame_key.step,
            "time": frame.frame_key.time,
            "time_unit": frame.frame_key.time_unit,
        }
    for key in ("step", "time"):
        value = scalar_values.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            header[key] = value
    header_bytes = json.dumps(
        header,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return struct.pack("<I", len(header_bytes)) + header_bytes + b"".join(payload_parts)


def _json_scalar(value: Any) -> float | int | bool | None:
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    number = float(value)
    return number if math.isfinite(number) else None
