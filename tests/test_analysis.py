"""Reference tests for trajectory analysis endpoints."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Event, RLock
from types import SimpleNamespace

import numpy as np
from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest

from PQAnalysis import __version__ as pqanalysis_version
from PQAnalysis.analysis import RDF
from PQAnalysis.io import TrajectoryReader
from PQAnalysis.traj import Trajectory

from pqviewer import analysis as analysis_module
from pqviewer.app import create_app
from pqviewer.data import FrameData, FrameKey


def _periodic_trajectory() -> str:
    frames = [
        [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (3.0, 0.0, 0.0)],
        [(0.0, 0.0, 0.0), (1.5, 0.0, 0.0), (3.5, 0.0, 0.0)],
        [(0.0, 0.0, 0.0), (2.0, 0.0, 0.0), (4.0, 0.0, 0.0)],
        [(0.0, 0.0, 0.0), (2.5, 0.0, 0.0), (4.5, 0.0, 0.0)],
    ]
    lines: list[str] = []
    for index, positions in enumerate(frames):
        lines.extend(["3 10 10 10", f"step={index} time={index * 0.5}"])
        for symbol, position in zip(("H", "H", "O"), positions, strict=True):
            lines.append(f"{symbol} {position[0]} {position[1]} {position[2]}")
    return "\n".join(lines) + "\n"


def test_positions_are_compact_unwrapped_and_keyed(tmp_path):
    trajectory = tmp_path / "crossing.xyz"
    trajectory.write_text(
        "1 10 10 10\nstep=0\nH 4.8 0 0\n1 10 10 10\nstep=1\nH -4.8 0 0\n",
        encoding="utf-8",
    )
    client = TestClient(create_app(trajectory))
    generation = client.get("/api/manifest").json()["dataset_generation"]

    result = client.post(
        "/api/positions",
        json={
            "dataset_generation": generation,
            "atom_indices": [0],
            "frame_indices": [0, 1],
            "coordinates": "unwrapped",
        },
    )

    assert result.status_code == 200
    body = result.json()
    assert body["schema_version"] == 1
    assert body["dataset_generation"] == generation
    assert body["atom_indices"] == [0]
    assert body["unit"] == "angstrom"
    assert [frame["index"] for frame in body["frames"]] == [0, 1]
    assert [frame["step"] for frame in body["frames"]] == [0, 1]
    assert body["frames"][0]["key"]["source_index"] == 0
    assert body["frames"][1]["key"]["source_index"] == 1
    np.testing.assert_allclose(
        [frame["positions"][0][0] for frame in body["frames"]],
        [4.8, 5.2],
    )

    source = client.post(
        "/api/positions",
        json={
            "dataset_generation": generation,
            "atom_indices": [0],
            "frame_indices": [1],
            "coordinates": "source",
        },
    ).json()
    np.testing.assert_allclose(source["frames"][0]["positions"][0], [-4.8, 0, 0])


def test_positions_validate_bounds_and_generation(tmp_path):
    trajectory = tmp_path / "one.xyz"
    trajectory.write_text("1 10 10 10\n\nH 0 0 0\n", encoding="utf-8")
    client = TestClient(create_app(trajectory))
    generation = client.get("/api/manifest").json()["dataset_generation"]

    assert (
        client.post(
            "/api/positions",
            json={
                "dataset_generation": generation,
                "atom_indices": list(range(33)),
                "frame_indices": [0],
            },
        ).status_code
        == 422
    )
    outside = client.post(
        "/api/positions",
        json={
            "dataset_generation": generation,
            "atom_indices": [1],
            "frame_indices": [0],
        },
    )
    assert outside.status_code == 422
    assert "Atom index" in outside.json()["detail"]
    duplicate = client.post(
        "/api/positions",
        json={
            "dataset_generation": generation,
            "atom_indices": [0, 0],
            "frame_indices": [0],
        },
    )
    assert duplicate.status_code == 422

    client.post("/api/refresh")
    stale = client.post(
        "/api/positions",
        json={
            "dataset_generation": generation,
            "atom_indices": [0],
            "frame_indices": [0],
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"] == "Trajectory changed. Reload the manifest."


def test_positions_hold_dataset_lock_while_reading_frames():
    class BlockingDataset:
        def __init__(self):
            self.entered = Event()
            self.release = Event()

        @staticmethod
        def manifest():
            return {
                "schema_version": 2,
                "name": "blocking",
                "frame_count": 1,
                "topology": {"atom_count": 1, "symbols": ["H"]},
            }

        def get_frame(self, index, *, coordinates="source"):
            self.entered.set()
            assert self.release.wait(timeout=5)
            return FrameData(
                index=index,
                positions=np.zeros((1, 3)),
                cell=np.eye(3),
                pbc=(True, True, True),
                units={"positions": "angstrom"},
                frame_key=FrameKey(source_id="blocking", source_index=index),
            )

    dataset = BlockingDataset()
    application = create_app(dataset=dataset)
    client = TestClient(application)
    generation = client.get("/api/manifest").json()["dataset_generation"]

    with ThreadPoolExecutor(max_workers=1) as pool:
        response = pool.submit(
            client.post,
            "/api/positions",
            json={
                "dataset_generation": generation,
                "atom_indices": [0],
                "frame_indices": [0],
                "coordinates": "source",
            },
        )
        assert dataset.entered.wait(timeout=5)
        acquired = application.state.dataset_lock.acquire(blocking=False)
        if acquired:
            application.state.dataset_lock.release()
        dataset.release.set()

        assert acquired is False
        assert response.result(timeout=5).status_code == 200


def test_rdf_matches_direct_pqanalysis_for_selected_frames(tmp_path):
    trajectory_path = tmp_path / "rdf.xyz"
    trajectory_path.write_text(_periodic_trajectory(), encoding="utf-8")
    application = create_app(trajectory_path)
    client = TestClient(application)
    generation = client.get("/api/manifest").json()["dataset_generation"]
    prepared = analysis_module._prepare_rdf_request(
        application.state.dataset,
        analysis_module.RDFRequest(
            dataset_generation=generation,
            reference_indices=[1, 0, 1],
            target_indices=[2],
            frame_start=1,
            frame_stop=4,
            frame_step=2,
            n_bins=5,
            r_max=5.0,
        ),
    )
    assert prepared["descriptor"]["native"] is False

    response = client.post(
        "/api/analysis/rdf",
        json={
            "dataset_generation": generation,
            "reference_indices": [1, 0, 1],
            "target_indices": [2],
            "frame_start": 1,
            "frame_stop": 4,
            "frame_step": 2,
            "n_bins": 5,
            "r_max": 5.0,
        },
    )

    assert response.status_code == 200
    result = response.json()
    source = TrajectoryReader(str(trajectory_path)).read()
    selected = Trajectory([source[1], source[3]])
    direct = RDF(
        selected,
        np.asarray([0, 1], dtype=np.int64),
        np.asarray([2], dtype=np.int64),
        n_bins=5,
        r_max=5.0,
        r_min=0.0,
    )
    centers, g_r, coordination, _, _ = direct.run()

    assert result["selections"]["reference_indices"] == [0, 1]
    assert result["selections"]["target_indices"] == [2]
    assert result["frame_range"]["start"] == 1
    assert result["frame_range"]["stop"] == 4
    assert result["frame_range"]["step"] == 2
    assert result["frame_range"]["count"] == 2
    assert result["frame_range"]["first_key"]["source_index"] == 1
    assert result["frame_range"]["last_key"]["source_index"] == 3
    assert result["units"] == {
        "radius": "angstrom",
        "g_r": "dimensionless",
        "coordination": "atoms",
    }
    assert result["pqanalysis_version"] == pqanalysis_version
    assert result["elapsed_seconds"] >= 0
    np.testing.assert_allclose(result["radius_centers"], centers)
    np.testing.assert_allclose(result["g_r"], g_r)
    np.testing.assert_allclose(result["coordination"], coordination)
    np.testing.assert_allclose(
        result["coordination_radius"],
        centers + direct.delta_r / 2.0,
    )


def test_full_pq_rdf_uses_the_native_reader(tmp_path):
    trajectory = tmp_path / "full.xyz"
    trajectory.write_text(_periodic_trajectory(), encoding="utf-8")
    application = create_app(trajectory)
    client = TestClient(application)
    generation = client.get("/api/manifest").json()["dataset_generation"]
    payload = analysis_module.RDFRequest(
        dataset_generation=generation,
        reference_indices=[0],
        target_indices=[2],
        n_bins=5,
        r_max=5.0,
    )

    prepared = analysis_module._prepare_rdf_request(
        application.state.dataset,
        payload,
    )
    result = client.post(
        "/api/analysis/rdf",
        json=payload.model_dump(),
    )

    assert prepared["descriptor"]["native"] is True
    assert result.status_code == 200
    assert result.json()["frame_range"]["count"] == 4


def test_generic_rdf_rejects_unsafe_atom_frame_volume(tmp_path, monkeypatch):
    trajectory = tmp_path / "bounded.xyz"
    trajectory.write_text(_periodic_trajectory(), encoding="utf-8")
    application = create_app(trajectory)
    client = TestClient(application)
    generation = client.get("/api/manifest").json()["dataset_generation"]
    monkeypatch.setattr(analysis_module, "MAX_GENERIC_RDF_ATOM_FRAMES", 5)

    result = client.post(
        "/api/analysis/rdf",
        json={
            "dataset_generation": generation,
            "reference_indices": [0],
            "target_indices": [2],
            "frame_start": 0,
            "frame_stop": 2,
            "n_bins": 5,
            "r_max": 5.0,
        },
    )

    assert result.status_code == 422
    assert result.json()["detail"] == (
        "RDF trajectory is too large to reconstruct. "
        "Reduce the selected frame range."
    )
    native = client.post(
        "/api/analysis/rdf",
        json={
            "dataset_generation": generation,
            "reference_indices": [0],
            "target_indices": [2],
            "n_bins": 5,
            "r_max": 5.0,
        },
    )
    assert native.status_code == 200


def test_rdf_rejects_nonperiodic_and_partial_cells(tmp_path):
    vacuum = tmp_path / "vacuum.xyz"
    vacuum.write_text("2\n\nH 0 0 0\nO 2 0 0\n", encoding="utf-8")
    vacuum_client = TestClient(create_app(vacuum))
    vacuum_generation = vacuum_client.get("/api/manifest").json()["dataset_generation"]
    vacuum_response = vacuum_client.post(
        "/api/analysis/rdf",
        json={
            "dataset_generation": vacuum_generation,
            "reference_indices": [0],
            "target_indices": [1],
            "n_bins": 5,
            "r_max": 5,
        },
    )
    assert vacuum_response.status_code == 422
    assert vacuum_response.json()["detail"] == (
        "RDF could not be calculated: RDF requires fully periodic frames."
    )

    partial = tmp_path / "partial.extxyz"
    partial.write_text(
        "2\n"
        'Lattice="10 0 0 0 10 0 0 0 10" '
        'Properties=species:S:1:pos:R:3 pbc="T T F"\n'
        "H 0 0 0\n"
        "O 2 0 0\n",
        encoding="utf-8",
    )
    partial_client = TestClient(create_app(partial))
    partial_generation = partial_client.get("/api/manifest").json()[
        "dataset_generation"
    ]
    partial_response = partial_client.post(
        "/api/analysis/rdf",
        json={
            "dataset_generation": partial_generation,
            "reference_indices": [0],
            "target_indices": [1],
            "n_bins": 5,
            "r_max": 5,
        },
    )
    assert partial_response.status_code == 422
    assert "fully periodic" in partial_response.json()["detail"]


def test_rdf_validates_indices_range_and_stale_generation(tmp_path):
    trajectory = tmp_path / "rdf.xyz"
    trajectory.write_text(_periodic_trajectory(), encoding="utf-8")
    client = TestClient(create_app(trajectory))
    generation = client.get("/api/manifest").json()["dataset_generation"]

    invalid_index = client.post(
        "/api/analysis/rdf",
        json={
            "dataset_generation": generation,
            "reference_indices": [3],
            "target_indices": [2],
        },
    )
    assert invalid_index.status_code == 422
    assert "Reference atom index" in invalid_index.json()["detail"]

    invalid_range = client.post(
        "/api/analysis/rdf",
        json={
            "dataset_generation": generation,
            "reference_indices": [0],
            "target_indices": [2],
            "frame_start": 3,
            "frame_stop": 3,
        },
    )
    assert invalid_range.status_code == 422

    client.post("/api/refresh")
    stale = client.post(
        "/api/analysis/rdf",
        json={
            "dataset_generation": generation,
            "reference_indices": [0],
            "target_indices": [2],
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"] == "Trajectory changed. Reload the manifest."


def test_rdf_worker_rejects_a_changed_source(tmp_path):
    trajectory = tmp_path / "changing.xyz"
    trajectory.write_text(_periodic_trajectory(), encoding="utf-8")
    application = create_app(trajectory)
    generation = application.state.dataset_generation
    prepared = analysis_module._prepare_rdf_request(
        application.state.dataset,
        analysis_module.RDFRequest(
            dataset_generation=generation,
            reference_indices=[0],
            target_indices=[2],
            n_bins=5,
            r_max=5.0,
        ),
    )
    trajectory.write_text(
        _periodic_trajectory() + "3 10 10 10\n\nH 0 0 0\nH 1 0 0\nO 3 0 0\n",
        encoding="utf-8",
    )

    with pytest.raises(analysis_module.AnalysisSourceChangedError):
        analysis_module._rdf_worker(
            prepared["descriptor"],
            prepared["worker_request"],
        )


def test_running_rdf_is_cancelled_when_generation_changes(monkeypatch):
    started = asyncio.Event()
    cancelled = asyncio.Event()
    options = {}

    async def slow_process(*args, **kwargs):
        options.update(kwargs)
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    class ConnectedRequest:
        @staticmethod
        async def is_disconnected():
            return False

    monkeypatch.setattr(analysis_module.to_process, "run_sync", slow_process)
    application = SimpleNamespace(
        state=SimpleNamespace(
            dataset_lock=RLock(),
            dataset_generation="current",
        )
    )

    async def run():
        task = asyncio.create_task(
            analysis_module._run_rdf_process(
                application,
                ConnectedRequest(),
                "current",
                {},
                {},
            )
        )
        await started.wait()
        application.state.dataset_generation = "new"
        with pytest.raises(HTTPException) as captured:
            await task
        assert captured.value.status_code == 409

    asyncio.run(run())

    assert cancelled.is_set()
    assert options["cancellable"] is True


def test_running_rdf_is_cancelled_when_client_disconnects(monkeypatch):
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def slow_process(*args, **kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    class DisconnectedRequest:
        @staticmethod
        async def is_disconnected():
            await started.wait()
            return True

    monkeypatch.setattr(analysis_module.to_process, "run_sync", slow_process)
    application = SimpleNamespace(
        state=SimpleNamespace(
            dataset_lock=RLock(),
            dataset_generation="current",
        )
    )

    async def run():
        task = asyncio.create_task(
            analysis_module._run_rdf_process(
                application,
                DisconnectedRequest(),
                "current",
                {},
                {},
            )
        )
        await started.wait()
        with pytest.raises(HTTPException) as captured:
            await task
        assert captured.value.status_code == 499

    asyncio.run(run())

    assert cancelled.is_set()
