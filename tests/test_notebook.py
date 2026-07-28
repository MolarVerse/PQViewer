from __future__ import annotations

import json
from pathlib import Path
from urllib.request import urlopen

import pytest

from pqviewer import NotebookViewer, view


EXAMPLE = Path(__file__).parents[1] / "examples" / "water.xyz"


def test_notebook_viewer_serves_and_embeds_the_application():
    viewer = view(EXAMPLE, height=420, title="Water structure")
    try:
        with urlopen(f"{viewer.url}api/health", timeout=5) as response:
            assert json.load(response) == {"status": "ok"}
        html = viewer._repr_html_()
        assert f'src="{viewer.url}"' in html
        assert 'title="Water structure"' in html
        assert "height:420px" in html
        assert "allowfullscreen" in html
    finally:
        viewer.close()
        viewer.close()


def test_notebook_viewer_validates_layout_and_port():
    with pytest.raises(ValueError, match="height"):
        NotebookViewer(EXAMPLE, height=319)
    with pytest.raises(ValueError, match="port"):
        NotebookViewer(EXAMPLE, port=65_536)
