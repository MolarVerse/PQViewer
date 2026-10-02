"""Shared I/O stubs for CLI argument tests."""

from collections.abc import Iterator
import socket

import pytest

from pqviewer import cli


@pytest.fixture
def server_io(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    with socket.socket() as listener:
        monkeypatch.setattr(cli, "create_server", lambda *args, **kwargs: listener)
        monkeypatch.setattr(cli.uvicorn.Server, "run", lambda *args, **kwargs: None)
        yield
