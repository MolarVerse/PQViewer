"""Build a bounded dataset for the read-only web demo."""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
from typing import Any

from .packet import encode_frame
from .sources import open_run_dataset


def build_static_demo(
    source: str | Path,
    destination: str | Path,
    *,
    max_frames: int = 120,
) -> dict[str, Any]:
    """Write a sanitized manifest and binary frame packets."""

    source_path = Path(source).resolve()
    destination_path = Path(destination)
    if max_frames < 1:
        raise ValueError("max_frames must be positive")

    dataset = open_run_dataset(source_path)
    manifest = deepcopy(dataset.manifest())
    frame_count = min(int(manifest["frame_count"]), max_frames)
    manifest["frame_count"] = frame_count
    manifest["dataset_generation"] = "static-demo-v1"
    manifest["coordinate_modes"] = ["source"]
    _trim_series(manifest, frame_count)
    _sanitize_source(manifest, source_path.name, frame_count)

    frames_path = destination_path / "frames"
    frames_path.mkdir(parents=True, exist_ok=True)
    (destination_path / "manifest.json").write_text(
        json.dumps(manifest, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    for index in range(frame_count):
        (frames_path / f"{index}.bin").write_bytes(
            encode_frame(dataset.get_frame(index)),
        )
    return manifest


def _trim_series(manifest: dict[str, Any], frame_count: int) -> None:
    for series in manifest.get("series", []):
        values = series.get("values")
        if isinstance(values, list):
            series["values"] = values[:frame_count]


def _sanitize_source(
    manifest: dict[str, Any],
    filename: str,
    frame_count: int,
) -> None:
    source = manifest.get("source")
    if not isinstance(source, dict):
        return
    source["path"] = filename
    for segment in source.get("segments", []):
        if not isinstance(segment, dict):
            continue
        segment["source_id"] = filename
        segment["path"] = filename
        segment["frame_count"] = min(
            int(segment.get("frame_count", frame_count)),
            frame_count,
        )
        files = segment.get("files")
        if isinstance(files, dict):
            segment["files"] = {
                key: Path(value).name if isinstance(value, str) else value
                for key, value in files.items()
            }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a bounded read-only dataset for the PQViewer web demo.",
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--max-frames", type=int, default=120)
    arguments = parser.parse_args()
    manifest = build_static_demo(
        arguments.source,
        arguments.destination,
        max_frames=arguments.max_frames,
    )
    print(
        f"Packed {manifest['frame_count']} frame(s) from {manifest['name']}",
    )
