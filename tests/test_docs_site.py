"""Documentation and gallery checks."""

from __future__ import annotations

from pathlib import Path
import re

import pytest

from pqviewer.recipe import open_figure_recipe_dataset


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
INDEX = DOCS / "index.md"


def test_docs_page_local_references_exist() -> None:
    source = INDEX.read_text(encoding="utf-8")
    references = re.findall(r"\]\((?!https?://)([^)#?]+)\)", source)
    references += re.findall(
        r"assets/[A-Za-z0-9_./-]+\.(?:extxyz|json|pdb|png|xyz)",
        source,
    )
    missing = sorted({
        reference
        for reference in references
        if not (DOCS / reference).exists()
    })
    assert missing == []


def test_docs_page_images_have_alt_text() -> None:
    source = INDEX.read_text(encoding="utf-8")
    assert source.count(":alt:") == 1
    assert source.count(":img-alt:") == 6


def test_docs_page_heading_order_is_consistent() -> None:
    source = INDEX.read_text(encoding="utf-8")
    levels = [len(markers) for markers in re.findall(r"^(#{1,6})\s", source, re.MULTILINE)]
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
        "periodicContext": name not in {"crambin", "nacl"},
    }
