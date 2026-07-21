"""Tests for the local PQViewer API and CLI."""

import os
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from pqviewer.app import create_app
from pqviewer import cli


class DatasetStub:
    def __init__(self) -> None:
        self.refresh_count = 0

    def manifest(self) -> dict:
        return {
            "schema_version": 1,
            "name": "water.xyz",
            "frame_count": 2 + self.refresh_count,
            "topology": {"atom_count": 3, "symbols": ["O", "H", "H"]},
            "series": [
                {
                    "name": "energy",
                    "label": "Energy",
                    "unit": "kcal/mol",
                    "values": [-1.0, -0.9],
                }
            ],
        }

    def get_frame(self, index: int) -> int:
        if index not in {0, 1}:
            raise IndexError(index)
        return index

    def refresh(self) -> int:
        self.refresh_count += 1
        return 1


def test_api_and_static_spa(tmp_path):
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<h1>PQViewer</h1>", encoding="utf-8")
    dataset = DatasetStub()
    client = TestClient(
        create_app(
            dataset=dataset,
            frame_encoder=lambda frame: f"frame:{frame}".encode(),
            static_dir=static_dir,
        )
    )

    assert client.get("/api/health").json() == {"status": "ok"}
    manifest = client.get("/api/manifest").json()
    assert manifest["series"][0]["unit"] == "kcal/mol"
    assert client.get("/api/manifest").headers["cache-control"] == "no-store"

    frame = client.get("/api/frames/1")
    assert frame.status_code == 200
    assert frame.headers["content-type"] == "application/octet-stream"
    assert frame.content == b"frame:1"
    assert client.get("/api/frames/2").status_code == 404

    refreshed = client.post("/api/refresh")
    assert refreshed.json()["frame_count"] == 3
    assert refreshed.json()["added_frames"] == 1
    assert dataset.refresh_count == 1

    assert "PQViewer" in client.get("/").text
    assert "PQViewer" in client.get("/viewer/trajectory").text
    assert client.get("/api/missing").status_code == 404
    assert client.get("/assets/missing.js").status_code == 404


def test_empty_trajectory_has_a_manifest_and_no_frames(tmp_path):
    trajectory = tmp_path / "empty.xyz"
    trajectory.write_text("", encoding="utf-8")
    client = TestClient(create_app(trajectory))

    manifest = client.get("/api/manifest")
    assert manifest.status_code == 200
    assert manifest.json()["frame_count"] == 0
    assert manifest.json()["topology"]["atom_count"] == 0
    assert manifest.json()["series"] == []
    assert client.get("/api/frames/0").status_code == 404


def test_api_accepts_a_force_companion(tmp_path):
    trajectory = tmp_path / "water.xyz"
    trajectory.write_text("1\n\nH 0 0 0\n", encoding="utf-8")
    forces = tmp_path / "water.force"
    forces.write_text("1\n\nH 1 2 3\n", encoding="utf-8")

    manifest = TestClient(
        create_app(trajectory, forces_path=forces)
    ).get("/api/manifest").json()

    assert manifest["properties"]["forces"]["unit"] == "kcal/(mol Å)"
    assert manifest["companion_files"]["forces"]["complete"] is True


def test_reload_cli_uses_factory_and_restores_environment(
    tmp_path,
    monkeypatch,
):
    trajectory = tmp_path / "empty.xyz"
    trajectory.write_text("", encoding="utf-8")
    previous = "previous.xyz"
    monkeypatch.setenv(cli.TRAJECTORY_ENV, previous)
    call = {}

    def run(application, **kwargs):
        call["application"] = application
        call["kwargs"] = kwargs
        call["trajectory"] = os.environ[cli.TRAJECTORY_ENV]

    monkeypatch.setattr(cli.uvicorn, "run", run)
    cli.main([str(trajectory), "--reload", "--no-open"])

    assert call["application"] == "pqviewer.app:create_app_from_env"
    assert call["kwargs"]["factory"] is True
    assert call["kwargs"]["port"] == 8765
    assert call["trajectory"] == str(trajectory.resolve())
    assert os.environ[cli.TRAJECTORY_ENV] == previous


def test_cli_passes_companion_paths(tmp_path, monkeypatch):
    trajectory = tmp_path / "run.xyz"
    forces = tmp_path / "run.force"
    velocities = tmp_path / "run.vel"
    charges = tmp_path / "run.chrg"
    for path in (trajectory, forces, velocities, charges):
        path.write_text("", encoding="utf-8")
    captured = {}

    def fake_create_app(path, **kwargs):
        captured["path"] = path
        captured.update(kwargs)
        dataset = SimpleNamespace(manifest=lambda: {})
        return SimpleNamespace(state=SimpleNamespace(dataset=dataset))

    monkeypatch.setattr(cli, "create_app", fake_create_app)
    monkeypatch.setattr(cli.uvicorn, "run", lambda *args, **kwargs: None)

    cli.main(
        [
            str(trajectory),
            "--forces",
            str(forces),
            "--velocities",
            str(velocities),
            "--charges",
            str(charges),
            "--no-open",
        ]
    )

    assert captured["path"] == trajectory
    assert captured["forces_path"] == forces
    assert captured["velocities_path"] == velocities
    assert captured["charges_path"] == charges


def test_cli_rejects_info_without_energy(tmp_path, capsys):
    trajectory = tmp_path / "empty.xyz"
    trajectory.write_text("", encoding="utf-8")
    info = tmp_path / "run.info"
    info.write_text("", encoding="utf-8")

    with pytest.raises(SystemExit) as error:
        cli.main([str(trajectory), "--info", str(info), "--no-open"])

    assert error.value.code == 2
    assert "--info requires --energy" in capsys.readouterr().err
