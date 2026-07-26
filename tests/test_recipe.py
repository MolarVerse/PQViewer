"""Figure recipe and headless rendering tests."""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
import builtins
from copy import deepcopy
from dataclasses import replace

from fastapi.testclient import TestClient
import numpy as np
import pytest

from pqviewer import cli, render_cli
from pqviewer.app import create_app
from pqviewer.data import FrameData
from pqviewer.recipe import (
    FIGURE_RECIPE_SCHEMA,
    FIGURE_RECIPE_VERSION,
    MAX_FIGURE_RECIPE_BYTES,
    figure_frame_fingerprint,
    is_figure_recipe_path,
    load_figure_recipe,
    open_figure_recipe_dataset,
)
from pqviewer.sources import open_run_dataset


def figure_recipe(source: str = "run.xyz") -> dict:
    return {
        "schema": FIGURE_RECIPE_SCHEMA,
        "schema_version": FIGURE_RECIPE_VERSION,
        "source": {
            "kind": "pq-trajectory",
            "path": source,
            "slice": {"start": None, "stop": None, "step": None},
            "segments": [
                {
                    "source_id": source,
                    "kind": "pq-trajectory",
                    "path": source,
                    "input": None,
                    "frame_count": 1,
                    "files": {"trajectory": source},
                }
            ],
        },
        "frame": {
            "index": 0,
            "fingerprint": "frame-v1:0000000000000000",
            "key": {
                "source_id": source,
                "source_index": 0,
                "segment_index": 0,
                "step": None,
                "time": None,
                "time_unit": None,
            },
        },
        "scene": {
            "presentation": {
                "mode": "ball-stick",
                "water": "show",
                "hydrogens": True,
                "wrap": "molecule",
                "cellOrigin": [0, 0, 0],
                "mirror": [False, False, False],
                "images": {"min": [0, 0, 0], "max": [0, 0, 0]},
                "cell": True,
                "forces": True,
                "velocities": False,
                "atomScale": 1,
                "bondScale": 1,
                "color": "element",
                "quality": "auto",
            },
            "selection": {
                "atoms": [],
                "intent": "measurement",
                "minimumImage": False,
            },
            "vectors": {"forceScale": 1, "velocityScale": 1},
        },
        "camera": {
            "position": [7, 5, 9],
            "target": [0, 0, 0],
            "up": [0, 1, 0],
            "fov": 34,
            "zoom": 1,
            "near": 0.02,
            "far": 5000,
        },
        "output": {
            "format": "png",
            "width": 2400,
            "height": 1800,
            "dpi": 300,
            "background": {"kind": "solid", "color": "#ffffff"},
            "projection": "orthographic",
            "fit": True,
            "padding": 0.08,
            "periodicContext": True,
        },
        "annotations": [],
    }


def write_source(path: Path) -> None:
    path.write_text("1\nframe\nH 0 0 0\n", encoding="utf-8")


def write_recipe(path: Path, recipe: dict) -> None:
    value = deepcopy(recipe)
    source = value.get("source")
    frame = value.get("frame")
    source_value = source.get("path") if isinstance(source, dict) else None
    source_path = (
        (path.parent / source_value).resolve()
        if isinstance(source_value, str) and source_value
        else None
    )
    source_slice = source.get("slice") if isinstance(source, dict) else None
    slice_values = (
        [source_slice.get(field) for field in ("start", "stop", "step")]
        if isinstance(source_slice, dict)
        else [None, None, None]
    )
    if (
        source_path is not None
        and source_path.is_file()
        and isinstance(frame, dict)
        and isinstance(frame.get("index"), int)
        and all(
            item is None or isinstance(item, int) and not isinstance(item, bool)
            for item in slice_values
        )
        and slice_values[2] != 0
    ):
        dataset = open_run_dataset(
            source_path,
            frame_slice=slice(*slice_values),
        )
        scene = value.get("scene")
        presentation = scene.get("presentation") if isinstance(scene, dict) else None
        selected = dataset.get_frame(
            frame["index"],
            coordinates=(
                "unwrapped"
                if isinstance(presentation, dict)
                and presentation.get("wrap") == "unwrapped"
                else "source"
            ),
        )
        frame["fingerprint"] = figure_frame_fingerprint(
            dataset.manifest(),
            selected,
        )
    path.write_text(json.dumps(value), encoding="utf-8")


def test_recipe_suffixes_are_explicit() -> None:
    assert is_figure_recipe_path("view.pqfigure.json")
    assert is_figure_recipe_path("VIEW.PQV.JSON")
    assert not is_figure_recipe_path("view.json")


def test_frame_fingerprint_matches_the_browser_contract() -> None:
    manifest = {
        "schema_version": 2,
        "name": "water.xyz",
        "frame_count": 1,
        "topology": {
            "atom_count": 2,
            "atomic_numbers": [8, 1],
            "bonds": [[0, 1]],
        },
    }
    frame = FrameData(
        index=0,
        positions=np.array([[0, 0, 0], [1, 0, 0]], dtype=np.float64),
        cell=np.eye(3, dtype=np.float64),
        pbc=(True, True, True),
    )

    assert figure_frame_fingerprint(manifest, frame) == (
        "frame-v1:8881a14a54d2137a"
    )
    unwrapped = replace(
        frame,
        coordinates="unwrapped",
        unwrapped_positions=np.array(
            [[0, 0, 0], [2, 0, 0]],
            dtype=np.float64,
        ),
        unwrapped_image_shifts=np.array(
            [[0, 0, 0], [1, 0, 0]],
            dtype=np.int64,
        ),
    )
    assert figure_frame_fingerprint(manifest, unwrapped) == (
        "frame-v1:b7d697621223d33d"
    )


def test_load_recipe_resolves_relative_source(tmp_path: Path) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    write_source(source)
    write_recipe(recipe_path, figure_recipe("run.xyz"))

    loaded, resolved_source = load_figure_recipe(recipe_path)

    assert loaded["frame"]["index"] == 0
    assert resolved_source == source


def test_load_recipe_accepts_polyhedra_and_rejects_unknown_modes(
    tmp_path: Path,
) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    write_source(source)
    recipe = figure_recipe("run.xyz")
    recipe["scene"]["presentation"]["mode"] = "polyhedra"
    write_recipe(recipe_path, recipe)

    loaded, _ = load_figure_recipe(recipe_path)
    assert loaded["scene"]["presentation"]["mode"] == "polyhedra"

    recipe["scene"]["presentation"]["mode"] = "facets"
    write_recipe(recipe_path, recipe)
    with pytest.raises(ValueError, match="presentation is invalid"):
        load_figure_recipe(recipe_path)


def test_open_recipe_reconstructs_slice_and_canonical_source(
    tmp_path: Path,
) -> None:
    source = tmp_path / "run.xyz"
    source.write_text(
        "1\nframe 1\nH 0 0 0\n"
        "1\nframe 2\nH 1 0 0\n"
        "1\nframe 3\nH 2 0 0\n",
        encoding="utf-8",
    )
    recipe_path = tmp_path / "view.pqfigure.json"
    recipe = figure_recipe("run.xyz")
    recipe["source"]["slice"] = {"start": 0, "stop": 3, "step": 2}
    recipe["source"]["segments"][0]["frame_count"] = 3
    recipe["frame"]["index"] = 1
    recipe["frame"]["key"]["source_index"] = 2
    write_recipe(recipe_path, recipe)

    canonical, dataset = open_figure_recipe_dataset(recipe_path)

    assert dataset.frame_count == 2
    assert canonical["source"]["path"] == str(source)
    assert canonical["source"]["slice"] == {"start": 0, "stop": 3, "step": 2}
    assert canonical["frame"]["key"]["source_index"] == 2


def test_open_recipe_accepts_a_growing_source(tmp_path: Path) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    write_source(source)
    write_recipe(recipe_path, figure_recipe("run.xyz"))
    source.write_text(
        "1\nframe 1\nH 0 0 0\n"
        "1\nframe 2\nH 1 0 0\n",
        encoding="utf-8",
    )

    canonical, dataset = open_figure_recipe_dataset(recipe_path)

    assert dataset.frame_count == 2
    assert canonical["source"]["segments"][0]["frame_count"] == 2
    assert canonical["frame"]["key"]["source_index"] == 0


def test_open_recipe_rejects_a_changed_frame_key(tmp_path: Path) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    write_source(source)
    recipe = figure_recipe("run.xyz")
    recipe["frame"]["key"]["step"] = 7
    write_recipe(recipe_path, recipe)

    with pytest.raises(ValueError, match="frame step changed"):
        open_figure_recipe_dataset(recipe_path)


def test_open_recipe_rejects_changed_frame_content(tmp_path: Path) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    write_source(source)
    write_recipe(recipe_path, figure_recipe("run.xyz"))
    source.write_text("1\nframe\nH 9 0 0\n", encoding="utf-8")

    with pytest.raises(ValueError, match="frame content changed"):
        open_figure_recipe_dataset(recipe_path)


def test_open_recipe_rejects_changed_unwrap_history(tmp_path: Path) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    source.write_text(
        '1\nLattice="10 0 0 0 10 0 0 0 10" '
        'Properties=species:S:1:pos:R:3 pbc="T T T" step=0\n'
        "C 4.8 0 0\n"
        '1\nLattice="10 0 0 0 10 0 0 0 10" '
        'Properties=species:S:1:pos:R:3 pbc="T T T" step=1\n'
        "C -4.8 0 0\n",
        encoding="utf-8",
    )
    recipe = figure_recipe("run.xyz")
    recipe["source"]["segments"][0]["frame_count"] = 2
    recipe["frame"]["index"] = 1
    recipe["frame"]["key"]["source_index"] = 1
    recipe["frame"]["key"]["step"] = 1
    recipe["scene"]["presentation"]["wrap"] = "unwrapped"
    write_recipe(recipe_path, recipe)
    source.write_text(
        '1\nLattice="10 0 0 0 10 0 0 0 10" '
        'Properties=species:S:1:pos:R:3 pbc="T T T" step=0\n'
        "C -4.0 0 0\n"
        '1\nLattice="10 0 0 0 10 0 0 0 10" '
        'Properties=species:S:1:pos:R:3 pbc="T T T" step=1\n'
        "C -4.8 0 0\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="frame content changed"):
        open_figure_recipe_dataset(recipe_path)


def test_load_recipe_requires_frame_fingerprint(tmp_path: Path) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    write_source(source)
    recipe = figure_recipe()
    del recipe["frame"]["fingerprint"]
    recipe_path.write_text(json.dumps(recipe), encoding="utf-8")

    with pytest.raises(ValueError, match="frame fingerprint"):
        load_figure_recipe(recipe_path)


def test_open_recipe_requires_frame_source_identity(tmp_path: Path) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    write_source(source)
    recipe = figure_recipe()
    recipe["frame"]["key"]["source_id"] = ""
    write_recipe(recipe_path, recipe)

    with pytest.raises(ValueError, match="frame source"):
        open_figure_recipe_dataset(recipe_path)


@pytest.mark.parametrize(
    ("change", "match"),
    [
        ({"schema": "other"}, "schema"),
        ({"schema_version": 2}, "version"),
        ({"annotations": {}}, "annotations"),
    ],
)
def test_load_recipe_rejects_invalid_root(
    tmp_path: Path,
    change: dict,
    match: str,
) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    write_source(source)
    recipe = figure_recipe()
    recipe.update(change)
    write_recipe(recipe_path, recipe)

    with pytest.raises(ValueError, match=match):
        load_figure_recipe(recipe_path)


def test_load_recipe_requires_reusable_source(tmp_path: Path) -> None:
    recipe_path = tmp_path / "view.pqfigure.json"
    recipe = figure_recipe()
    recipe["source"]["path"] = ""
    write_recipe(recipe_path, recipe)

    with pytest.raises(ValueError, match="reusable source"):
        load_figure_recipe(recipe_path)


def test_render_rejects_invalid_slice_without_a_traceback(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    write_source(source)
    recipe = figure_recipe("run.xyz")
    recipe["source"]["slice"]["start"] = "bad"
    write_recipe(recipe_path, recipe)

    with pytest.raises(SystemExit) as exit_info:
        render_cli.main([
            str(recipe_path),
            "--output",
            str(tmp_path / "figure.png"),
        ])

    assert exit_info.value.code == 2
    error = capsys.readouterr().err
    assert "slice start must be an integer" in error
    assert "Traceback" not in error


def test_render_rejects_invalid_presentation_without_a_traceback(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    write_source(source)
    recipe = figure_recipe("run.xyz")
    recipe["scene"]["presentation"] = "bad"
    write_recipe(recipe_path, recipe)

    with pytest.raises(SystemExit) as exit_info:
        render_cli.main([
            str(recipe_path),
            "--output",
            str(tmp_path / "figure.png"),
        ])

    assert exit_info.value.code == 2
    error = capsys.readouterr().err
    assert "presentation is invalid" in error
    assert "Traceback" not in error


def test_load_recipe_bounds_input_size(tmp_path: Path) -> None:
    recipe_path = tmp_path / "large.pqfigure.json"
    recipe_path.write_bytes(b" " * (MAX_FIGURE_RECIPE_BYTES + 1))

    with pytest.raises(ValueError, match="too large"):
        load_figure_recipe(recipe_path)


def test_cli_normalizes_decoder_recursion_without_a_traceback(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    recipe_path = tmp_path / "nested.pqfigure.json"
    recipe_path.write_text(
        "[" * 10_000 + "0" + "]" * 10_000,
        encoding="utf-8",
    )

    with pytest.raises(SystemExit) as exit_info:
        cli.main([str(recipe_path), "--no-open"])

    assert exit_info.value.code == 2
    error = capsys.readouterr().err
    assert "figure recipe is invalid" in error
    assert "Traceback" not in error


def test_cli_rejects_deeply_nested_recipe_without_a_traceback(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "nested.pqfigure.json"
    write_source(source)
    recipe = figure_recipe()
    nested: object = 0
    for _ in range(80):
        nested = [nested]
    recipe["annotations"] = nested
    recipe_path.write_text(json.dumps(recipe), encoding="utf-8")

    with pytest.raises(SystemExit) as exit_info:
        cli.main([str(recipe_path), "--no-open"])

    assert exit_info.value.code == 2
    error = capsys.readouterr().err
    assert "too deeply nested" in error
    assert "Traceback" not in error


def test_initial_recipe_endpoint_is_isolated() -> None:
    recipe = figure_recipe("/tmp/run.xyz")
    application = create_app(dataset=SimpleNamespace(
        manifest=lambda: {
            "schema_version": 1,
            "name": "run.xyz",
            "frame_count": 0,
            "topology": {"atom_count": 0},
        },
        refresh=lambda: 0,
    ), initial_recipe=recipe)
    recipe["frame"]["index"] = 9

    with TestClient(application) as client:
        first = client.get("/api/initial-recipe")
        first.json()["frame"]["index"] = 7
        second = client.get("/api/initial-recipe")

    assert first.headers["cache-control"] == "no-store"
    assert second.json()["frame"]["index"] == 0


def test_opening_files_clears_initial_recipe(tmp_path: Path) -> None:
    source = tmp_path / "run.xyz"
    write_source(source)

    with TestClient(create_app(source, initial_recipe=figure_recipe(str(source)))) as client:
        assert client.get("/api/initial-recipe").json() is not None
        opened = client.post(
            "/api/open",
            files=[("files", ("other.xyz", b"1\nframe\nHe 0 0 0\n", "text/plain"))],
        )
        current = client.get("/api/initial-recipe")

    assert opened.status_code == 200
    assert current.json() is None


def test_cli_opens_recipe_source_and_passes_recipe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    write_source(source)
    write_recipe(recipe_path, figure_recipe("run.xyz"))
    captured: dict[str, object] = {}

    def fake_create_app(path, **kwargs):
        captured["path"] = path
        captured["recipe"] = kwargs["initial_recipe"]
        captured["dataset"] = kwargs["dataset"]
        dataset = SimpleNamespace(manifest=lambda: {})
        return SimpleNamespace(state=SimpleNamespace(dataset=dataset))

    monkeypatch.setattr(cli, "create_app", fake_create_app)
    monkeypatch.setattr(cli.uvicorn, "run", lambda *args, **kwargs: None)

    cli.main([str(recipe_path), "--no-open"])

    assert captured["path"] is None
    assert captured["dataset"].manifest()["source"]["path"] == str(source)
    assert captured["recipe"]["schema"] == FIGURE_RECIPE_SCHEMA


@pytest.mark.parametrize(
    ("name", "requested", "expected"),
    [
        ("figure.png", None, "png"),
        ("figure.tif", None, "tiff"),
        ("figure.tiff", "tiff", "tiff"),
    ],
)
def test_output_format_follows_extension(
    name: str,
    requested: str | None,
    expected: str,
) -> None:
    assert render_cli.resolve_output_format(Path(name), requested) == expected


def test_output_format_rejects_mismatch() -> None:
    with pytest.raises(ValueError, match="does not match"):
        render_cli.resolve_output_format(Path("figure.tiff"), "png")
    with pytest.raises(ValueError, match=r"\.png"):
        render_cli.resolve_output_format(Path("figure.jpg"))


def test_headless_render_dependency_error_is_explicit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "run.xyz"
    write_source(source)
    real_import = builtins.__import__

    def missing_playwright(name, *args, **kwargs):
        if name == "playwright.sync_api":
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", missing_playwright)

    with pytest.raises(RuntimeError, match=r"\[render\]"):
        render_cli.render_recipe(
            figure_recipe(str(source)),
            SimpleNamespace(),
            tmp_path / "figure.png",
        )


def test_headless_render_output_error_is_concise(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    blocked = tmp_path / "blocked"
    write_source(source)
    write_recipe(recipe_path, figure_recipe("run.xyz"))
    blocked.write_text("not a directory", encoding="utf-8")

    with pytest.raises(SystemExit) as exit_info:
        render_cli.main([
            str(recipe_path),
            "--output",
            str(blocked / "figure.png"),
        ])

    assert exit_info.value.code == 1
    error = capsys.readouterr().err
    assert error.startswith("pqviewer render: ")
    assert "Traceback" not in error


@pytest.mark.parametrize("timeout", ["nan", "inf", "-inf", "0"])
def test_headless_render_rejects_invalid_timeout_concisely(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    timeout: str,
) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    write_source(source)
    write_recipe(recipe_path, figure_recipe("run.xyz"))

    with pytest.raises(SystemExit) as exit_info:
        render_cli.main([
            str(recipe_path),
            "--output",
            str(tmp_path / "figure.png"),
            f"--timeout={timeout}",
        ])

    assert exit_info.value.code == 1
    error = capsys.readouterr().err
    assert "positive finite number" in error
    assert "Traceback" not in error


@pytest.mark.skipif(
    os.environ.get("PQVIEWER_HEADLESS_TEST") != "1",
    reason="requires the render extra and Chromium",
)
def test_headless_render_rejects_unsupported_polyhedra(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "polyhedra.pqfigure.json"
    output = tmp_path / "figure.png"
    write_source(source)
    recipe = figure_recipe("run.xyz")
    recipe["scene"]["presentation"]["mode"] = "polyhedra"
    write_recipe(recipe_path, recipe)

    with pytest.raises(SystemExit) as exit_info:
        render_cli.main([
            str(recipe_path),
            "--output",
            str(output),
            "--width",
            "320",
            "--height",
            "240",
        ])

    assert exit_info.value.code == 1
    error = capsys.readouterr().err
    assert error.startswith("pqviewer render: ")
    assert "Polyhedra unavailable" in error
    assert "supported center with 3+ bonded ligands" in error
    assert "Traceback" not in error
    assert not output.exists()


@pytest.mark.skipif(
    os.environ.get("PQVIEWER_HEADLESS_TEST") != "1",
    reason="requires the render extra and Chromium",
)
def test_headless_render_command_produces_exact_rasters(tmp_path: Path) -> None:
    source = tmp_path / "run.xyz"
    recipe_path = tmp_path / "view.pqfigure.json"
    output = tmp_path / "figure.png"
    repeated_output = tmp_path / "figure-repeated.png"
    tiff_output = tmp_path / "figure.tiff"
    write_source(source)
    recipe = figure_recipe("run.xyz")
    recipe["annotations"] = [
        {
            "kind": "legend",
            "content": "elements",
            "position": "top-right",
        }
    ]
    write_recipe(recipe_path, recipe)

    render_cli.main([
        str(recipe_path),
        "--output",
        str(output),
        "--width",
        "640",
        "--height",
        "480",
        "--dpi",
        "144",
    ])
    render_cli.main([
        str(recipe_path),
        "--output",
        str(tiff_output),
        "--width",
        "320",
        "--height",
        "240",
        "--dpi",
        "144",
        "--transparent",
    ])
    render_cli.main([
        str(recipe_path),
        "--output",
        str(repeated_output),
        "--width",
        "640",
        "--height",
        "480",
        "--dpi",
        "144",
    ])

    png = output.read_bytes()
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    assert int.from_bytes(png[16:20], "big") == 640
    assert int.from_bytes(png[20:24], "big") == 480
    assert b"sRGB" in png
    assert b"pHYs" in png
    assert repeated_output.read_bytes() == png

    from PIL import Image

    with Image.open(tiff_output) as image:
        image.load()
        assert image.format == "TIFF"
        assert image.size == (320, 240)
        assert image.mode == "RGBA"
        assert image.info["dpi"] == pytest.approx((144, 144))
        alpha_min, alpha_max = image.getchannel("A").getextrema()
        assert alpha_min < 255
        assert alpha_max == 255
