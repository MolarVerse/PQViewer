"""Binary frame packets for the browser renderer."""

from __future__ import annotations

import json
import math
import struct
from typing import Any

import numpy as np

from .data import FrameData, SCHEMA_VERSION


def encode_frame(frame: FrameData) -> bytes:
    """Encode a frame as a JSON header followed by float32 arrays."""
    arrays = (
        ("positions", frame.positions),
        ("cell", frame.cell),
        ("forces", frame.forces),
        ("velocities", frame.velocities),
        ("charges", frame.charges),
    )
    payload_parts: list[bytes] = []
    array_metadata: list[dict[str, Any]] = []
    offset = 0

    for name, values in arrays:
        if values is None:
            continue
        array = np.ascontiguousarray(values, dtype=np.dtype("<f4"))
        chunk = array.tobytes(order="C")
        array_metadata.append({
            "name": name,
            "dtype": "float32",
            "byte_order": "little",
            "shape": list(array.shape),
            "byte_offset": offset,
            "byte_length": len(chunk),
            "unit": frame.units.get(name),
        })
        payload_parts.append(chunk)
        offset += len(chunk)

    header = {
        "schema_version": SCHEMA_VERSION,
        "index": frame.index,
        "pbc": list(frame.pbc),
        "scalars": {
            key: _json_scalar(value) for key, value in frame.scalars.items()
        },
        "scalar_units": {
            key: frame.units.get(key) for key in frame.scalars
        },
        "arrays": array_metadata,
        "payload_byte_length": offset,
    }
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
