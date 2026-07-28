from __future__ import annotations

import json
from pathlib import Path

from pqviewer import FrameData
from pqviewer.packet import encode_frame
from pqviewer.static_demo import build_static_demo


class _Dataset:
    def manifest(self):
        return {
            "schema_version": 2,
            "name": "example.xyz",
            "frame_count": 2,
            "coordinate_modes": ["source", "unwrapped"],
            "topology": {"atom_count": 1, "atomic_numbers": [1]},
            "series": [{"name": "step", "values": [0, 1]}],
            "source": {
                "path": "/private/build/example.xyz",
                "segments": [{
                    "source_id": "/private/build/example.xyz",
                    "path": "/private/build/example.xyz",
                    "frame_count": 2,
                    "files": {"trajectory": "/private/build/example.xyz"},
                }],
            },
        }

    def get_frame(self, index):
        import numpy as np

        return FrameData(
            index=index,
            positions=np.zeros((1, 3)),
            cell=np.eye(3),
            pbc=(False, False, False),
        )


def test_static_demo_is_bounded_and_sanitized(tmp_path, monkeypatch):
    dataset = _Dataset()
    monkeypatch.setattr(
        "pqviewer.static_demo.open_run_dataset",
        lambda _source: dataset,
    )

    output = tmp_path / "demo"
    manifest = build_static_demo(
        tmp_path / "example.xyz",
        output,
        max_frames=1,
    )

    assert manifest["frame_count"] == 1
    assert manifest["coordinate_modes"] == ["source"]
    assert manifest["source"]["path"] == "example.xyz"
    assert manifest["source"]["segments"][0]["source_id"] == "example.xyz"
    assert manifest["source"]["segments"][0]["files"] == {
        "trajectory": "example.xyz",
    }
    assert manifest["series"][0]["values"] == [0]
    assert json.loads((output / "manifest.json").read_text()) == manifest
    assert (output / "frames" / "0.bin").read_bytes() == encode_frame(
        dataset.get_frame(0),
    )
