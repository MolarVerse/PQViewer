"""Local web application for PQViewer."""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .data import PQTrajectoryDataset
from .packet import encode_frame


TRAJECTORY_ENV = "PQVIEWER_TRAJECTORY"
ENERGY_ENV = "PQVIEWER_ENERGY"
INFO_ENV = "PQVIEWER_INFO"


class SPAStaticFiles(StaticFiles):
    """Serve the SPA entry point for browser-side routes."""

    async def get_response(self, path: str, scope: dict[str, Any]) -> Response:
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as error:
            if error.status_code != 404:
                raise
            response = None

        if response is not None and response.status_code != 404:
            return response
        if not self._is_browser_route(path, scope):
            if response is not None:
                return response
            raise StarletteHTTPException(status_code=404)
        return await super().get_response("index.html", scope)

    @staticmethod
    def _is_browser_route(path: str, scope: dict[str, Any]) -> bool:
        if scope["method"] not in {"GET", "HEAD"}:
            return False
        if path == "api" or path.startswith("api/"):
            return False
        return not PurePosixPath(path).suffix


def create_app(
    trajectory_path: str | Path | None = None,
    *,
    energy_path: str | Path | None = None,
    info_path: str | Path | None = None,
    dataset: Any | None = None,
    frame_encoder: Callable[[Any], bytes] = encode_frame,
    static_dir: str | Path | None = None,
) -> FastAPI:
    """Create an application for one trajectory dataset."""

    if dataset is None:
        if trajectory_path is None:
            raise ValueError("A trajectory path is required.")
        dataset = PQTrajectoryDataset(
            trajectory_path,
            energy_path=energy_path,
            info_path=info_path,
        )

    application = FastAPI(title="PQViewer")
    application.state.dataset = dataset

    @application.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/api/manifest")
    def manifest(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return dataset.manifest()

    @application.get("/api/frames/{frame_index}")
    def frame(frame_index: int) -> Response:
        try:
            value = dataset.get_frame(frame_index)
        except IndexError as error:
            raise HTTPException(status_code=404, detail="Frame not found.") from error

        return Response(
            frame_encoder(value),
            media_type="application/octet-stream",
            headers={"Cache-Control": "no-store"},
        )

    @application.post("/api/refresh")
    def refresh(response: Response) -> dict[str, Any]:
        added_frames = dataset.refresh()
        refreshed_manifest = dict(dataset.manifest())
        refreshed_manifest["added_frames"] = added_frames
        response.headers["Cache-Control"] = "no-store"
        return refreshed_manifest

    frontend = (
        Path(static_dir)
        if static_dir is not None
        else Path(__file__).with_name("static")
    )
    if (frontend / "index.html").is_file():
        application.mount("/", SPAStaticFiles(directory=frontend, html=True), name="frontend")
    else:

        @application.get("/", include_in_schema=False)
        def missing_frontend() -> PlainTextResponse:
            return PlainTextResponse(
                "PQViewer frontend is not built.",
                status_code=503,
            )

    return application


def create_app_from_env() -> FastAPI:
    """Create the application configured by the CLI environment."""

    trajectory_path = os.environ.get(TRAJECTORY_ENV)
    if not trajectory_path:
        raise RuntimeError(f"{TRAJECTORY_ENV} is not set.")

    return create_app(
        trajectory_path,
        energy_path=os.environ.get(ENERGY_ENV),
        info_path=os.environ.get(INFO_ENV),
    )
