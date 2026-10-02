"""Command-line startup failures at the process boundary."""

from pathlib import Path
import socket
import subprocess
import sys

import pytest


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
    assert "PQViewer: http" not in result.stdout
