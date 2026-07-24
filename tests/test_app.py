"""Tests for the local PQViewer API and CLI."""

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
from threading import Event
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from pqviewer.app import create_app
from pqviewer import app as app_module
from pqviewer import cli


WATER_DIMER = """6 10 10 10
water dimer
O 0 0 0
H 1 0 0
H 0 1 0
O 3 0 0
H 4 0 0
H 3 1 0
"""

MOLDESCRIPTOR = """WATER_TYPE 1
H2O 3 0.0
O 0 -0.65966
H 1 0.32983
H 1 0.32983
"""

SHAKE_TOPOLOGY = """SHAKE
1 2 1
1 3 1
4 5 1
4 6 1
END
"""


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
    generation = manifest["dataset_generation"]
    assert isinstance(generation, str)
    assert generation
    assert client.get("/api/manifest").headers["cache-control"] == "no-store"

    frame = client.get("/api/frames/1")
    assert frame.status_code == 200
    assert frame.headers["content-type"] == "application/octet-stream"
    assert frame.content == b"frame:1"
    assert client.get(
        "/api/frames/1",
        params={"dataset_generation": generation},
    ).content == b"frame:1"
    assert client.get("/api/frames/2").status_code == 404

    refreshed = client.post("/api/refresh")
    assert refreshed.json()["frame_count"] == 3
    assert refreshed.json()["added_frames"] == 1
    refreshed_generation = refreshed.json()["dataset_generation"]
    assert refreshed_generation != generation
    assert client.get(
        "/api/frames/1",
        params={"dataset_generation": generation},
    ).status_code == 409
    assert client.get(
        "/api/frames/1",
        params={"dataset_generation": refreshed_generation},
    ).content == b"frame:1"
    assert dataset.refresh_count == 1

    assert "PQViewer" in client.get("/").text
    assert "PQViewer" in client.get("/viewer/trajectory").text
    assert client.get("/api/missing").status_code == 404
    assert client.get("/assets/missing.js").status_code == 404


def test_frame_api_selects_unwrapped_coordinates(tmp_path):
    class CoordinateDataset(DatasetStub):
        coordinates = "source"

        def get_frame(self, index: int, *, coordinates: str = "source") -> int:
            self.coordinates = coordinates
            return super().get_frame(index)

    dataset = CoordinateDataset()
    client = TestClient(
        create_app(
            dataset=dataset,
            frame_encoder=lambda frame: f"frame:{frame}".encode(),
            static_dir=tmp_path,
        )
    )

    response = client.get(
        "/api/frames/1",
        params={"coordinates": "unwrapped"},
    )

    assert response.status_code == 200
    assert dataset.coordinates == "unwrapped"
    assert client.get(
        "/api/frames/1",
        params={"coordinates": "invalid"},
    ).status_code == 422


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


def test_app_starts_empty_and_opens_a_trajectory():
    application = create_app()

    with TestClient(application) as client:
        initial = client.get("/api/manifest")
        opened = client.post(
            "/api/open",
            files={"files": ("opened.xyz", "1\n\nH 0 0 0\n", "text/plain")},
        )
        upload_directory = Path(application.state.upload_temp.name)

        assert initial.status_code == 200
        assert initial.json()["name"] == "No trajectory"
        assert initial.json()["frame_count"] == 0
        assert initial.json()["topology"]["atom_residue_index"] == []
        assert opened.status_code == 200
        assert opened.json()["name"] == "opened.xyz"
        assert client.get("/api/frames/0").status_code == 200

    assert application.state.upload_temp is None
    assert not upload_directory.exists()


def test_stale_frame_generation_never_reads_a_replacement_dataset(
    monkeypatch,
):
    application = create_app()

    with TestClient(application) as client:
        initial_generation = client.get("/api/manifest").json()[
            "dataset_generation"
        ]
        first = client.post(
            "/api/open",
            files={"files": ("first.xyz", "1\n\nH 0 0 0\n", "text/plain")},
        )
        first_generation = first.json()["dataset_generation"]

        assert first_generation != initial_generation
        assert client.get(
            "/api/frames/0",
            params={"dataset_generation": first_generation},
        ).status_code == 200

        second = client.post(
            "/api/open",
            files={"files": ("second.xyz", "1\n\nO 1 0 0\n", "text/plain")},
        )
        second_generation = second.json()["dataset_generation"]
        replacement_get_frame = application.state.dataset.get_frame
        replacement_reads = []

        def read_replacement(frame_index):
            replacement_reads.append(frame_index)
            return replacement_get_frame(frame_index)

        monkeypatch.setattr(
            application.state.dataset,
            "get_frame",
            read_replacement,
        )

        stale = client.get(
            "/api/frames/0",
            params={"dataset_generation": first_generation},
        )
        assert second_generation not in {
            initial_generation,
            first_generation,
        }
        assert stale.status_code == 409
        assert stale.json() == {
            "detail": "Trajectory changed. Reload the manifest."
        }
        assert replacement_reads == []
        assert client.get(
            "/api/frames/0",
            params={"dataset_generation": second_generation},
        ).status_code == 200
        assert client.get("/api/frames/0").status_code == 200
        assert replacement_reads == [0, 0]
        assert client.get("/api/manifest").json()[
            "dataset_generation"
        ] == second_generation


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


def test_routes_resolve_the_current_dataset(tmp_path):
    first = DatasetStub()
    second = DatasetStub()
    second.refresh_count = 4
    application = create_app(
        dataset=first,
        frame_encoder=lambda frame: f"frame:{frame}".encode(),
        static_dir=tmp_path,
    )
    application.state.dataset = second
    client = TestClient(application)

    assert client.get("/api/manifest").json()["frame_count"] == 6
    assert client.get("/api/frames/1").content == b"frame:1"
    assert client.post("/api/refresh").json()["frame_count"] == 7
    assert first.refresh_count == 0


def test_open_upload_swaps_dataset_and_cleans_previous_upload(tmp_path):
    trajectory = tmp_path / "initial.xyz"
    trajectory.write_text("1\n\nH 0 0 0\n", encoding="utf-8")
    application = create_app(trajectory)

    with TestClient(application) as client:
        opened = client.post(
            "/api/open",
            files=[
                ("files", ("../fresh.xyz", "1\n\nH 1 0 0\n", "text/plain")),
                ("files", ("fresh.force", "1\n\nH 1 2 3\n", "text/plain")),
            ],
        )
        first_directory = Path(application.state.upload_temp.name).resolve()

        assert opened.status_code == 200
        assert opened.json()["name"] == "fresh.xyz"
        assert opened.json()["companion_files"]["forces"]["complete"] is True
        assert application.state.dataset.path.name == "fresh.xyz"
        assert application.state.dataset.path.parent == first_directory

        replaced = client.post(
            "/api/open",
            files={"files": ("second.xyz", "1\n\nO 0 0 0\n", "text/plain")},
        )
        second_directory = Path(application.state.upload_temp.name).resolve()

        assert replaced.status_code == 200
        assert replaced.json()["name"] == "second.xyz"
        assert not first_directory.exists()

    assert application.state.upload_temp is None
    assert not second_directory.exists()


def test_newer_open_request_cannot_be_replaced_by_an_older_one(monkeypatch):
    application = create_app()
    slow_started = Event()
    release_slow = Event()
    original_open = app_module._open_uploaded_dataset

    def delayed_open(paths):
        if paths["trajectory"].name == "slow.xyz":
            slow_started.set()
            assert release_slow.wait(timeout=5)
        return original_open(paths)

    monkeypatch.setattr(app_module, "_open_uploaded_dataset", delayed_open)
    with TestClient(application) as client, ThreadPoolExecutor(max_workers=1) as pool:
        slow_future = pool.submit(
            client.post,
            "/api/open",
            files={"files": ("slow.xyz", "1\n\nH 0 0 0\n", "text/plain")},
        )
        assert slow_started.wait(timeout=5)
        fast = client.post(
            "/api/open",
            files={"files": ("fast.xyz", "1\n\nO 0 0 0\n", "text/plain")},
        )
        release_slow.set()
        slow = slow_future.result(timeout=5)

        assert fast.status_code == 200
        assert slow.status_code == 409
        assert client.get("/api/manifest").json()["name"] == "fast.xyz"


def test_open_upload_keeps_current_dataset_after_validation_error(tmp_path):
    trajectory = tmp_path / "initial.xyz"
    trajectory.write_text("1\n\nH 0 0 0\n", encoding="utf-8")
    application = create_app(trajectory)
    original = application.state.dataset

    with TestClient(application) as client:
        response = client.post(
            "/api/open",
            files=[
                ("files", ("fresh.xyz", "1\n\nH 1 0 0\n", "text/plain")),
                ("files", ("other.force", "1\n\nH 1 2 3\n", "text/plain")),
            ],
        )

        assert response.status_code == 400
        assert "must match the trajectory name" in response.json()["detail"]
        assert application.state.dataset is original


def test_open_upload_keeps_current_dataset_when_candidate_is_invalid(tmp_path):
    trajectory = tmp_path / "initial.xyz"
    trajectory.write_text("1\n\nH 0 0 0\n", encoding="utf-8")
    application = create_app(trajectory)
    original = application.state.dataset

    with TestClient(application) as client:
        response = client.post(
            "/api/open",
            files=[
                ("files", ("fresh.xyz", "1\n\nH 1 0 0\n", "text/plain")),
                (
                    "files",
                    ("fresh.top", "SHAKE\n1 2 1\nEND\n", "text/plain"),
                ),
            ],
        )

        assert response.status_code == 400
        assert "out-of-range atom index" in response.json()["detail"]
        assert application.state.dataset is original
        assert application.state.upload_temp is None


def test_open_upload_enforces_file_size_limit(tmp_path, monkeypatch):
    trajectory = tmp_path / "initial.xyz"
    trajectory.write_text("1\n\nH 0 0 0\n", encoding="utf-8")
    monkeypatch.setattr(app_module, "MAX_UPLOAD_FILE_BYTES", 8)

    with TestClient(create_app(trajectory)) as client:
        response = client.post(
            "/api/open",
            files={"files": ("large.xyz", "1\n\nH 0 0 0\n", "text/plain")},
        )

    assert response.status_code == 413
    assert response.json()["detail"] == "Upload file is too large"


def test_open_upload_enforces_total_size_while_parsing(tmp_path, monkeypatch):
    trajectory = tmp_path / "initial.xyz"
    trajectory.write_text("1\n\nH 0 0 0\n", encoding="utf-8")
    monkeypatch.setattr(app_module, "MAX_UPLOAD_FILE_BYTES", 64)
    monkeypatch.setattr(app_module, "MAX_UPLOAD_TOTAL_BYTES", 20)

    with TestClient(create_app(trajectory)) as client:
        response = client.post(
            "/api/open",
            files=[
                ("files", ("large.xyz", "1\n\nH 0 0 0\n", "text/plain")),
                ("files", ("large.force", "1\n\nH 1 2 3\n", "text/plain")),
            ],
        )

    assert response.status_code == 413
    assert response.json()["detail"] == "Upload is too large"


def test_open_upload_enforces_file_count(tmp_path, monkeypatch):
    trajectory = tmp_path / "initial.xyz"
    trajectory.write_text("1\n\nH 0 0 0\n", encoding="utf-8")
    monkeypatch.setattr(app_module, "MAX_UPLOAD_FILES", 1)

    with TestClient(create_app(trajectory)) as client:
        response = client.post(
            "/api/open",
            files=[
                ("files", ("run.xyz", "1\n\nH 0 0 0\n", "text/plain")),
                ("files", ("run.force", "1\n\nH 1 2 3\n", "text/plain")),
            ],
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "Too many files. Maximum number of files is 1."


def test_open_upload_adds_residue_and_bond_metadata(tmp_path):
    trajectory = tmp_path / "initial.xyz"
    trajectory.write_text("1\n\nH 0 0 0\n", encoding="utf-8")

    with TestClient(create_app(trajectory)) as client:
        response = client.post(
            "/api/open",
            files=[
                ("files", ("water.xyz", WATER_DIMER, "text/plain")),
                ("files", ("moldescriptor.dat", MOLDESCRIPTOR, "text/plain")),
                ("files", ("water.top", SHAKE_TOPOLOGY, "text/plain")),
            ],
        )

    assert response.status_code == 200
    topology = response.json()["topology"]
    assert topology["atom_residue_index"] == [0, 0, 0, 1, 1, 1]
    assert [residue["category"] for residue in topology["residues"]] == [
        "water",
        "water",
    ]
    assert topology["bonds"] == [[0, 1], [0, 2], [3, 4], [3, 5]]


def test_reload_cli_uses_factory_and_restores_environment(
    tmp_path,
    monkeypatch,
):
    trajectory = tmp_path / "empty.xyz"
    trajectory.write_text("", encoding="utf-8")
    moldescriptor = tmp_path / "moldescriptor.dat"
    moldescriptor.write_text(MOLDESCRIPTOR, encoding="utf-8")
    topology = tmp_path / "topology.top"
    topology.write_text(SHAKE_TOPOLOGY, encoding="utf-8")
    previous = "previous.xyz"
    monkeypatch.setenv(cli.TRAJECTORY_ENV, previous)
    call = {}

    def run(application, **kwargs):
        call["application"] = application
        call["kwargs"] = kwargs
        call["trajectory"] = os.environ[cli.TRAJECTORY_ENV]
        call["moldescriptor"] = os.environ[cli.MOLDESCRIPTOR_ENV]
        call["topology"] = os.environ[cli.TOPOLOGY_ENV]

    monkeypatch.setattr(cli.uvicorn, "run", run)
    cli.main([
        str(trajectory),
        "--moldescriptor",
        str(moldescriptor),
        "--topology",
        str(topology),
        "--reload",
        "--no-open",
    ])

    assert call["application"] == "pqviewer.app:create_app_from_env"
    assert call["kwargs"]["factory"] is True
    assert call["kwargs"]["port"] == 8765
    assert call["trajectory"] == str(trajectory.resolve())
    assert call["moldescriptor"] == str(moldescriptor.resolve())
    assert call["topology"] == str(topology.resolve())
    assert os.environ[cli.TRAJECTORY_ENV] == previous


def test_reload_cli_supports_an_empty_launch(tmp_path, monkeypatch):
    previous = "previous.xyz"
    monkeypatch.setenv(cli.TRAJECTORY_ENV, previous)
    call = {}

    def run(application, **kwargs):
        call["application"] = application
        call["factory"] = kwargs["factory"]
        call["trajectory"] = os.environ.get(cli.TRAJECTORY_ENV)

    monkeypatch.setattr(cli.uvicorn, "run", run)
    cli.main(["--reload", "--no-open"])

    assert call == {
        "application": "pqviewer.app:create_app_from_env",
        "factory": True,
        "trajectory": None,
    }
    assert os.environ[cli.TRAJECTORY_ENV] == previous


def test_environment_factory_supports_an_empty_launch(monkeypatch):
    for name in (
        cli.TRAJECTORY_ENV,
        cli.ENERGY_ENV,
        cli.INFO_ENV,
        cli.FORCES_ENV,
        cli.VELOCITIES_ENV,
        cli.CHARGES_ENV,
        cli.MOLDESCRIPTOR_ENV,
        cli.TOPOLOGY_ENV,
    ):
        monkeypatch.delenv(name, raising=False)

    manifest = app_module.create_app_from_env().state.dataset.manifest()

    assert manifest["name"] == "No trajectory"
    assert manifest["frame_count"] == 0


def test_cli_passes_companion_paths(tmp_path, monkeypatch):
    trajectory = tmp_path / "run.xyz"
    forces = tmp_path / "run.force"
    velocities = tmp_path / "run.vel"
    charges = tmp_path / "run.chrg"
    moldescriptor = tmp_path / "moldescriptor.dat"
    topology = tmp_path / "topology.top"
    for path in (trajectory, forces, velocities, charges, moldescriptor, topology):
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
            "--moldescriptor",
            str(moldescriptor),
            "--topology",
            str(topology),
            "--no-open",
        ]
    )

    assert captured["path"] == trajectory
    assert captured["forces_path"] == forces
    assert captured["velocities_path"] == velocities
    assert captured["charges_path"] == charges
    assert captured["moldescriptor_path"] == moldescriptor
    assert captured["topology_path"] == topology


def test_cli_rejects_info_without_energy(tmp_path, capsys):
    trajectory = tmp_path / "empty.xyz"
    trajectory.write_text("", encoding="utf-8")
    info = tmp_path / "run.info"
    info.write_text("", encoding="utf-8")

    with pytest.raises(SystemExit) as error:
        cli.main([str(trajectory), "--info", str(info), "--no-open"])

    assert error.value.code == 2
    assert "--info requires --energy" in capsys.readouterr().err
