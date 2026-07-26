"""Static documentation site checks."""

from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pytest

from pqviewer.recipe import open_figure_recipe_dataset


ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "docs" / "index.html"


class _DocumentParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[tuple[str, str]] = []
        self.images_without_alt: list[str] = []
        self.heading_levels: list[int] = []

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        values = dict(attrs)
        if tag in {"a", "link"} and values.get("href"):
            self.references.append((tag, values["href"] or ""))
        if tag in {"img", "script"} and values.get("src"):
            self.references.append((tag, values["src"] or ""))
        if tag == "img" and "alt" not in values:
            self.images_without_alt.append(values.get("src") or "<unknown>")
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self.heading_levels.append(int(tag[1]))


def _parser() -> _DocumentParser:
    parser = _DocumentParser()
    parser.feed(INDEX.read_text(encoding="utf-8"))
    return parser


def test_docs_page_local_references_exist() -> None:
    parser = _parser()
    missing: list[str] = []
    for _, reference in parser.references:
        parsed = urlsplit(reference)
        if parsed.scheme or parsed.netloc or not parsed.path:
            continue
        target = (INDEX.parent / unquote(parsed.path)).resolve()
        if not target.exists():
            missing.append(reference)
    assert missing == []


def test_docs_page_images_have_alt_text() -> None:
    assert _parser().images_without_alt == []


def test_docs_page_heading_order_is_consistent() -> None:
    levels = _parser().heading_levels
    assert levels[0] == 1
    assert all(next_level <= level + 1 for level, next_level in zip(levels, levels[1:]))


@pytest.mark.parametrize(
    "name",
    ("c60", "crambin", "nacl", "water-box"),
)
def test_gallery_recipes_reopen_their_sources(name: str) -> None:
    pytest.importorskip("ase")
    recipe_path = ROOT / "docs" / "assets" / "recipes" / f"{name}.pqfigure.json"
    recipe, dataset = open_figure_recipe_dataset(recipe_path)
    assert dataset.frame_count == 1
    assert recipe["output"] == {
        "format": "png",
        "width": 2400,
        "height": 1800,
        "dpi": 300,
        "background": {"kind": "solid", "color": "#f5f8f8"},
        "projection": "orthographic",
        "fit": True,
        "padding": 0.1 if name != "crambin" else 0.11,
        "periodicContext": name != "crambin",
    }
