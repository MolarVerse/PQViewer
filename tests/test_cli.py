"""Command-line startup failures at the process boundary."""

from contextlib import contextmanager
from importlib.metadata import version
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pytest


@contextmanager
def running_viewer(*arguments: str):
    with socket.create_server(("127.0.0.1", 0)) as listener:
        port = listener.getsockname()[1]
    process = subprocess.Popen(
        [sys.executable, "-m", "pqviewer.cli", *arguments, "--no-open", "--port", str(port)],
        cwd=Path(__file__).resolve().parents[1],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    result = SimpleNamespace(process=process, port=port, url=f"http://127.0.0.1:{port}")
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                with urlopen(f"{result.url}/api/health", timeout=0.2) as response:
                    assert json.load(response) == {"status": "ok"}
                break
            except (OSError, URLError):
                if process.poll() is not None:
                    raise AssertionError("Viewer exited before serving")
                time.sleep(0.05)
        else:
            raise AssertionError("Viewer did not start")
        yield result
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGINT)
        try:
            result.stdout, result.stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            result.stdout, result.stderr = process.communicate(timeout=5)


@pytest.mark.parametrize("reload", [False, True])
def test_ctrl_c_stops_without_a_traceback(reload: bool) -> None:
    with running_viewer(*(["--reload"] if reload else [])) as result:
        assert result.process.poll() is None

    assert "Traceback" not in result.stderr
    assert result.process.returncode == 0


@pytest.mark.parametrize("reload", [False, True])
def test_occupied_port_has_a_clean_cli_error(reload: bool) -> None:
    with socket.create_server(("127.0.0.1", 0)) as listener:
        port = listener.getsockname()[1]
        arguments = [
            sys.executable,
            "-m",
            "pqviewer.cli",
            "--no-open",
            "--port",
            str(port),
        ]
        if reload:
            arguments.append("--reload")
        result = subprocess.run(
            arguments,
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )

    assert result.returncode == 2
    assert "address already in use" in result.stderr.lower()
    assert "Choose another --port" in result.stderr
    assert "Traceback" not in result.stderr
    assert not result.stdout


@pytest.mark.parametrize("option", ["--help", "--version"])
def test_cli_identity_is_readable_when_redirected(option: str) -> None:
    result = subprocess.run(
        [sys.executable, "-m", "pqviewer.cli", option],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0
    assert not result.stderr
    assert "\x1b[" not in result.stdout
    if option == "--version":
        assert result.stdout.strip() == version("MolarVerse-PQViewer")
    else:
        assert "--log-level" in result.stdout
        assert "127.0.0.1" in result.stdout
        assert "8765" in result.stdout


def json_request(url: str, path: str, payload=None, *, method: str = "GET"):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    try:
        response = urlopen(Request(url + path, data=data, headers=headers, method=method), timeout=10)
    except HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response)


@pytest.mark.parametrize(
    ("reload", "level"),
    [(False, "info"), (True, "debug"), (True, "warning"), (False, "error")],
)
def test_browser_cli_events_follow_log_level(tmp_path: Path, reload: bool, level: str) -> None:
    source = tmp_path / "trajectory.xyz"
    frame = "2 10 10 10\n\nH 0 0 0\nO 2 0 0\n"
    source.write_text(frame)
    arguments = [str(source), "--log-level", level]
    if reload:
        arguments.append("--reload")
    with running_viewer(*arguments) as result:
        with socket.create_connection(("127.0.0.1", result.port), timeout=5) as malformed:
            malformed.sendall(b"invalid request\r\n\r\n")
            assert b"400 Bad Request" in malformed.recv(1024)
        status, manifest = json_request(result.url, "/api/manifest")
        assert status == 200
        assert manifest["frame_count"] == 1
        with urlopen(f"{result.url}/api/frames/0", timeout=5) as response:
            assert response.status == 200
        assert json_request(result.url, "/api/refresh", method="POST")[1]["added_frames"] == 0
        source.write_text(frame * 2)
        status, refreshed = json_request(result.url, "/api/refresh", method="POST")
        assert status == 200
        assert refreshed["added_frames"] == 1
        parameters = {
            "dataset_generation": refreshed["dataset_generation"],
            "reference_indices": [0],
            "target_indices": [1],
            "n_bins": 5,
            "r_max": 3,
        }
        status, analysis = json_request(result.url, "/api/analysis/rdf", parameters, method="POST")
        assert status == 200
        assert analysis["frame_range"]["count"] == 2
        status, error = json_request(
            result.url,
            "/api/analysis/rdf",
            {**parameters, "reference_indices": [999]},
            method="POST",
        )
        assert status == 422
        assert "Reference atom index" in error["detail"]

        boundary = "pqviewer-event-fixture"
        upload = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="opened.xyz"\r\n'
            'Content-Type: text/plain\r\n\r\n' + frame + f'\r\n--{boundary}--\r\n'
        ).encode()
        with urlopen(Request(
            result.url + "/api/open",
            data=upload,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        ), timeout=10) as response:
            assert json.load(response)["name"] == "opened.xyz"

    assert result.process.returncode == 0
    assert "Open   " + result.url in result.stdout
    assert "2 atoms · 1 frame" in result.stdout
    assert "\x1b[" not in result.stdout + result.stderr
    assert "Traceback" not in result.stderr
    assert ("Opening " in result.stderr) == (level == "debug")
    assert ("Invalid HTTP request received" in result.stderr) == (level != "error")
    if level in {"info", "debug"}:
        assert "Ready" in result.stderr
        assert "Added 1 frame (2 total)" in result.stderr
        assert "Opened opened.xyz (atoms: 2, frames: 1)" in result.stderr
        assert "RDF started (2 frames, 5 bins)" in result.stderr
        assert "RDF completed" in result.stderr
        assert "Stopped" in result.stderr
    else:
        assert "Ready" not in result.stderr
        assert "Opened opened.xyz" not in result.stderr
        assert "Stopped" not in result.stderr
    assert ("RDF unavailable" in result.stderr) == (level != "error")
    assert ("No new frames" in result.stderr) == (level == "debug")
    assert ('"GET /api/' in result.stdout + result.stderr) == (level == "debug")


def test_source_error_is_logged_without_a_traceback(tmp_path: Path) -> None:
    result = subprocess.run(
        [sys.executable, "-m", "pqviewer.cli", str(tmp_path / "missing.xyz"), "--no-open", "--log-level", "error"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 2
    assert "ERROR" in result.stderr
    assert "Could not open source" in result.stderr
    assert "Traceback" not in result.stderr
    assert not result.stdout
