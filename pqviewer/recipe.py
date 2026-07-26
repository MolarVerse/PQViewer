"""Trusted local figure recipe loading."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict
import json
import math
from pathlib import Path
import re
import struct
from typing import Any, Mapping


FIGURE_RECIPE_SCHEMA = "pqviewer.figure"
FIGURE_RECIPE_VERSION = 1
FIGURE_RECIPE_SUFFIXES = (".pqfigure.json", ".pqv.json")
MAX_FIGURE_RECIPE_BYTES = 1_048_576
MAX_FIGURE_RECIPE_DEPTH = 64
MAX_FIGURE_RECIPE_NODES = 100_000
_COMPANION_ROLES = (
    "energy",
    "info",
    "forces",
    "velocities",
    "charges",
    "moldescriptor",
    "topology",
)
_FINGERPRINT_ARRAYS = {
    "positions",
    "cell",
    "forces",
    "velocities",
    "charges",
}
_UNWRAPPED_FINGERPRINT_ARRAYS = {
    "unwrapped_positions",
    "unwrapped_image_shifts",
}


def is_figure_recipe_path(path: str | Path) -> bool:
    """Return whether a path uses a supported recipe suffix."""
    lowered = str(path).casefold()
    return any(lowered.endswith(suffix) for suffix in FIGURE_RECIPE_SUFFIXES)


def load_figure_recipe(path: str | Path) -> tuple[dict[str, Any], Path]:
    """Load a trusted local recipe and resolve its source path."""
    recipe_path = Path(path).expanduser().resolve()
    if not recipe_path.is_file():
        raise FileNotFoundError(recipe_path)
    if recipe_path.stat().st_size > MAX_FIGURE_RECIPE_BYTES:
        raise ValueError("figure recipe is too large")
    try:
        value = json.loads(recipe_path.read_text(encoding="utf-8"))
    except (
        OSError,
        RecursionError,
        UnicodeError,
        json.JSONDecodeError,
    ) as error:
        raise ValueError("figure recipe is invalid") from error
    recipe = _validated_recipe(value)
    source_value = recipe["source"].get("path")
    if not isinstance(source_value, str) or not source_value.strip():
        raise ValueError("figure recipe does not contain a reusable source path")
    candidate = Path(source_value).expanduser()
    source_path = (
        candidate
        if candidate.is_absolute()
        else recipe_path.parent / candidate
    ).resolve()
    if not source_path.exists():
        raise FileNotFoundError(source_path)
    return recipe, source_path


def open_figure_recipe_dataset(path: str | Path) -> tuple[dict[str, Any], Any]:
    """Open a trusted recipe with its exact source slice and companion files."""
    recipe_path = Path(path).expanduser().resolve()
    recipe, source_path = load_figure_recipe(recipe_path)
    source = recipe["source"]
    slice_value = source.get("slice")
    frame_slice = None
    if isinstance(slice_value, Mapping):
        frame_slice = slice(
            slice_value.get("start"),
            slice_value.get("stop"),
            slice_value.get("step"),
        )
        if frame_slice.step == 0:
            raise ValueError("figure recipe source slice step cannot be zero")
    companions = _recipe_companion_paths(recipe, recipe_path.parent)

    from .sources import open_run_dataset

    dataset = open_run_dataset(
        source_path,
        frame_slice=frame_slice,
        **{f"{role}_path": value for role, value in companions.items()},
    )
    manifest = dataset.manifest()
    manifest_source = manifest.get("source")
    if not isinstance(manifest_source, Mapping):
        raise ValueError("reopened figure source has no provenance")
    _validate_reopened_source(source, manifest_source, recipe_path.parent)
    frame_index = recipe["frame"]["index"]
    try:
        frame = dataset.get_frame(
            frame_index,
            coordinates=_recipe_coordinate_mode(recipe),
        )
    except IndexError as error:
        raise ValueError("figure recipe frame is outside the reopened source") from error
    if frame.frame_key is None:
        raise ValueError("reopened figure frame has no stable key")
    reopened_key = asdict(frame.frame_key)
    _validate_reopened_frame_key(
        recipe["frame"].get("key"),
        reopened_key,
        recipe_path.parent,
    )
    reopened_fingerprint = figure_frame_fingerprint(manifest, frame)
    if recipe["frame"].get("fingerprint") != reopened_fingerprint:
        raise ValueError("figure recipe frame content changed")

    canonical = deepcopy(recipe)
    canonical["source"] = deepcopy(dict(manifest_source))
    canonical["frame"]["key"] = reopened_key
    canonical["frame"]["fingerprint"] = reopened_fingerprint
    return canonical, dataset


def recipe_copy(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Return an isolated JSON-compatible recipe copy."""
    if value is None:
        return None
    return deepcopy(_validated_recipe(value))


def _validated_recipe(value: Any) -> dict[str, Any]:
    _validate_json_complexity(value)
    if not isinstance(value, Mapping):
        raise ValueError("figure recipe must be an object")
    if value.get("schema") != FIGURE_RECIPE_SCHEMA:
        raise ValueError("figure recipe schema is unsupported")
    if value.get("schema_version") != FIGURE_RECIPE_VERSION:
        raise ValueError("figure recipe version is unsupported")
    source = value.get("source")
    frame = value.get("frame")
    scene = value.get("scene")
    camera = value.get("camera")
    output = value.get("output")
    annotations = value.get("annotations")
    if not isinstance(source, Mapping):
        raise ValueError("figure recipe source is missing")
    source_slice = source.get("slice")
    if source_slice is not None:
        if not isinstance(source_slice, Mapping):
            raise ValueError("figure recipe source slice is invalid")
        for field in ("start", "stop", "step"):
            slice_index = source_slice.get(field)
            if (
                slice_index is not None
                and (
                    not isinstance(slice_index, int)
                    or isinstance(slice_index, bool)
                )
            ):
                raise ValueError(
                    f"figure recipe source slice {field} must be an integer"
                )
        if source_slice.get("step") == 0:
            raise ValueError("figure recipe source slice step cannot be zero")
    if (
        not isinstance(frame, Mapping)
        or not isinstance(frame.get("index"), int)
        or isinstance(frame.get("index"), bool)
        or frame.get("index", -1) < 0
        or not isinstance(frame.get("key"), Mapping)
    ):
        raise ValueError("figure recipe frame is invalid")
    fingerprint = frame.get("fingerprint")
    if (
        not isinstance(fingerprint, str)
        or re.fullmatch(r"frame-v1:[0-9a-f]{16}", fingerprint) is None
    ):
        raise ValueError("figure recipe frame fingerprint is invalid")
    if not isinstance(scene, Mapping):
        raise ValueError("figure recipe scene is missing")
    presentation = scene.get("presentation")
    if (
        not isinstance(presentation, Mapping)
        or presentation.get("mode")
        not in {
            "ball-stick",
            "spacefill",
            "licorice",
            "lines",
            "ribbon",
            "polyhedra",
        }
        or presentation.get("wrap")
        not in {"atom", "molecule", "unwrapped", "none"}
    ):
        raise ValueError("figure recipe presentation is invalid")
    if not isinstance(camera, Mapping):
        raise ValueError("figure recipe camera is missing")
    if not isinstance(output, Mapping):
        raise ValueError("figure recipe output is missing")
    if not isinstance(annotations, list):
        raise ValueError("figure recipe annotations are invalid")
    return dict(value)


def _validate_json_complexity(value: Any) -> None:
    stack: list[tuple[Any, int]] = [(value, 0)]
    visited = 0
    while stack:
        current, depth = stack.pop()
        visited += 1
        if visited > MAX_FIGURE_RECIPE_NODES:
            raise ValueError("figure recipe is too complex")
        if depth > MAX_FIGURE_RECIPE_DEPTH:
            raise ValueError("figure recipe is too deeply nested")
        if isinstance(current, Mapping):
            children = list(current.values())
        elif isinstance(current, (list, tuple)):
            children = list(current)
        else:
            continue
        if visited + len(stack) + len(children) > MAX_FIGURE_RECIPE_NODES:
            raise ValueError("figure recipe is too complex")
        stack.extend((child, depth + 1) for child in children)


def _recipe_coordinate_mode(
    recipe: Mapping[str, Any],
) -> str:
    scene = recipe.get("scene")
    presentation = scene.get("presentation") if isinstance(scene, Mapping) else None
    if not isinstance(presentation, Mapping):
        raise ValueError("figure recipe presentation is invalid")
    return "unwrapped" if presentation.get("wrap") == "unwrapped" else "source"


def _recipe_companion_paths(
    recipe: Mapping[str, Any],
    base: Path,
) -> dict[str, Path]:
    source = recipe.get("source")
    segments = source.get("segments") if isinstance(source, Mapping) else None
    if not isinstance(segments, list) or not segments:
        return {}
    values: dict[str, set[Path]] = {role: set() for role in _COMPANION_ROLES}
    for segment in segments:
        files = segment.get("files") if isinstance(segment, Mapping) else None
        if not isinstance(files, Mapping):
            continue
        for role in _COMPANION_ROLES:
            value = files.get(role)
            if isinstance(value, str) and value.strip():
                values[role].add(_resolved_local_path(value, base))
    result: dict[str, Path] = {}
    for role, paths in values.items():
        if len(paths) == 1:
            result[role] = next(iter(paths))
    return result


def _validate_reopened_source(
    expected: Mapping[str, Any],
    actual: Mapping[str, Any],
    base: Path,
) -> None:
    if expected.get("kind") != actual.get("kind"):
        raise ValueError("figure recipe source kind changed")
    expected_slice = expected.get("slice")
    if isinstance(expected_slice, Mapping):
        actual_slice = actual.get("slice")
        for field in ("start", "stop", "step"):
            if not isinstance(actual_slice, Mapping) or (
                expected_slice.get(field) != actual_slice.get(field)
            ):
                raise ValueError("figure recipe source slice changed")
    expected_segments = expected.get("segments")
    actual_segments = actual.get("segments")
    if not isinstance(expected_segments, list) or not isinstance(actual_segments, list):
        raise ValueError("figure recipe source segments are missing")
    if len(expected_segments) != len(actual_segments):
        raise ValueError("figure recipe source segments changed")
    for expected_segment, actual_segment in zip(
        expected_segments,
        actual_segments,
        strict=True,
    ):
        if not isinstance(expected_segment, Mapping) or not isinstance(
            actual_segment,
            Mapping,
        ):
            raise ValueError("figure recipe source segment is invalid")
        if expected_segment.get("kind") != actual_segment.get("kind"):
            raise ValueError("figure recipe source segment kind changed")
        for field in ("path", "input"):
            _compare_recipe_path(
                expected_segment.get(field),
                actual_segment.get(field),
                base,
                f"figure recipe source {field}",
            )
        expected_files = expected_segment.get("files")
        actual_files = actual_segment.get("files")
        if not isinstance(expected_files, Mapping) or not isinstance(
            actual_files,
            Mapping,
        ):
            raise ValueError("figure recipe source files are invalid")
        for role, value in expected_files.items():
            _compare_recipe_path(
                value,
                actual_files.get(role),
                base,
                f"figure recipe {role} file",
            )


def _validate_reopened_frame_key(
    expected: Any,
    actual: Mapping[str, Any],
    base: Path,
) -> None:
    if not isinstance(expected, Mapping):
        raise ValueError("figure recipe frame key is invalid")
    source_id = expected.get("source_id")
    if not isinstance(source_id, str) or not source_id.strip():
        raise ValueError("figure recipe frame source is invalid")
    _compare_recipe_path(
        source_id,
        actual.get("source_id"),
        base,
        "figure recipe frame source",
    )
    for field in (
        "source_index",
        "segment_index",
        "step",
        "time",
        "time_unit",
    ):
        if expected.get(field) != actual.get(field):
            raise ValueError(f"figure recipe frame {field} changed")


def figure_frame_fingerprint(
    manifest: Mapping[str, Any],
    frame: Any,
) -> str:
    """Fingerprint the source arrays and topology used by a figure."""
    from .packet import encode_frame

    packet = encode_frame(frame)
    header_size = struct.unpack_from("<I", packet)[0]
    payload_start = 4 + header_size
    header = json.loads(packet[4:payload_start])
    array_names = set(_FINGERPRINT_ARRAYS)
    if frame.coordinates == "unwrapped":
        array_names.update(_UNWRAPPED_FINGERPRINT_ARRAYS)
    descriptors = [
        descriptor
        for descriptor in header.get("arrays", [])
        if str(descriptor.get("name", "")).casefold()
        in array_names
    ]
    fingerprint = _FigureFingerprint()
    fingerprint.value(manifest.get("topology"))
    fingerprint.value({
        "arrays": descriptors,
        "pbc": header.get("pbc"),
    })
    for descriptor in sorted(
        descriptors,
        key=lambda item: str(item.get("name", "")).casefold(),
    ):
        name = str(descriptor["name"]).casefold()
        fingerprint.value(name)
        fingerprint.value(
            "Int32Array"
            if str(descriptor.get("dtype", "")).casefold() == "int32"
            else "Float32Array"
        )
        offset = payload_start + int(descriptor["byte_offset"])
        length = int(descriptor["byte_length"])
        fingerprint.bytes(packet[offset:offset + length])
    return f"frame-v1:{fingerprint.digest()}"


def _compare_recipe_path(
    expected: Any,
    actual: Any,
    base: Path,
    label: str,
) -> None:
    if expected is None:
        return
    if (
        not isinstance(expected, str)
        or not isinstance(actual, str)
        or _resolved_local_path(expected, base)
        != Path(actual).expanduser().resolve()
    ):
        raise ValueError(f"{label} changed")


def _resolved_local_path(value: str, base: Path) -> Path:
    path = Path(value).expanduser()
    return (path if path.is_absolute() else base / path).resolve()


class _FigureFingerprint:
    def __init__(self) -> None:
        self.first = 0x811C9DC5
        self.second = 0x9E3779B9

    def bytes(self, values: bytes | bytearray | memoryview) -> None:
        for byte in values:
            self.first = (
                ((self.first ^ byte) * 0x01000193)
                & 0xFFFFFFFF
            )
            self.second = (
                ((self.second ^ byte) * 0x85EBCA6B)
                & 0xFFFFFFFF
            )
            self.second = (
                self.second ^ (self.second >> 13)
            ) & 0xFFFFFFFF

    def value(self, value: Any) -> None:
        if value is None:
            self.text("null")
        elif isinstance(value, bool):
            self.text("true" if value else "false")
        elif isinstance(value, str):
            length = len(value.encode("utf-16-le")) // 2
            self.text(f"s{length}:")
            self.text(value)
        elif isinstance(value, (int, float)):
            number = float(value)
            if not math.isfinite(number):
                raise ValueError("figure fingerprint contains a non-finite number")
            self.text("n")
            self.bytes(struct.pack("<d", number))
        elif isinstance(value, (list, tuple)):
            self.text("[")
            for item in value:
                self.value(item)
            self.text("]")
        elif isinstance(value, Mapping):
            self.text("{")
            for key in sorted(value):
                self.value(str(key))
                self.value(value[key])
            self.text("}")
        else:
            raise ValueError(
                f"figure fingerprint contains unsupported {type(value).__name__}"
            )

    def digest(self) -> str:
        return f"{self.first:08x}{self.second:08x}"

    def text(self, value: str) -> None:
        self.bytes(value.encode("utf-8"))
