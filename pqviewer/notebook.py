"""Jupyter display support for the local PQViewer application."""

from __future__ import annotations

import atexit
from html import escape
import socket
from threading import Thread
import time
from typing import Any

import uvicorn

from .app import create_app


class NotebookViewer:
    """A local PQViewer server with a Jupyter iframe representation."""

    def __init__(
        self,
        source: Any,
        *,
        height: int = 640,
        host: str = "127.0.0.1",
        port: int | None = None,
        title: str = "PQViewer",
        **source_options: Any,
    ) -> None:
        if height < 320:
            raise ValueError("height must be at least 320 pixels")
        if port is not None and not 0 < port < 65_536:
            raise ValueError("port must be between 1 and 65535")

        self.height = int(height)
        self.host = host
        self.title = title
        self._closed = False
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._socket.bind((host, port or 0))
        self._socket.listen(128)
        self.port = int(self._socket.getsockname()[1])

        application = create_app(source, **source_options)
        configuration = uvicorn.Config(
            application,
            host=host,
            port=self.port,
            log_level="warning",
            access_log=False,
        )
        self._server = uvicorn.Server(configuration)
        self._thread = Thread(
            target=self._run,
            name=f"pqviewer-notebook-{self.port}",
            daemon=True,
        )
        self._thread.start()
        self._wait_until_started()
        atexit.register(self.close)

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}/"

    def _repr_html_(self) -> str:
        source = escape(self.url, quote=True)
        title = escape(self.title, quote=True)
        return (
            f'<iframe src="{source}" title="{title}" '
            f'style="width:100%;height:{self.height}px;border:1px solid #d7e0e2;'
            'border-radius:10px;background:#f6f8f8" '
            'loading="eager" allowfullscreen></iframe>'
        )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._server.should_exit = True
        if self._thread.is_alive():
            self._thread.join(timeout=5)
        try:
            self._socket.close()
        except OSError:
            pass

    def __enter__(self) -> NotebookViewer:
        return self

    def __exit__(self, *_exc_info: object) -> None:
        self.close()

    def _run(self) -> None:
        self._server.run(sockets=[self._socket])

    def _wait_until_started(self) -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self._server.started:
                return
            if not self._thread.is_alive():
                break
            time.sleep(0.02)
        self.close()
        raise RuntimeError("PQViewer did not start")


def view(
    source: Any,
    *,
    height: int = 640,
    host: str = "127.0.0.1",
    port: int | None = None,
    title: str = "PQViewer",
    **source_options: Any,
) -> NotebookViewer:
    """Start and display a local PQViewer from a notebook cell."""

    return NotebookViewer(
        source,
        height=height,
        host=host,
        port=port,
        title=title,
        **source_options,
    )
