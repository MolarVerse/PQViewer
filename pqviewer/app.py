"""Local web application for PQViewer."""

from __future__ import annotations

from contextlib import asynccontextmanager
import os
from pathlib import Path, PurePosixPath
import secrets
from tempfile import TemporaryDirectory
from threading import RLock
from typing import Any, Callable, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.formparsers import MultiPartException, MultiPartParser

from .data import EmptyTrajectoryDataset, PQTrajectoryDataset
from .packet import encode_frame


TRAJECTORY_ENV = "PQVIEWER_TRAJECTORY"
ENERGY_ENV = "PQVIEWER_ENERGY"
INFO_ENV = "PQVIEWER_INFO"
FORCES_ENV = "PQVIEWER_FORCES"
VELOCITIES_ENV = "PQVIEWER_VELOCITIES"
CHARGES_ENV = "PQVIEWER_CHARGES"
MOLDESCRIPTOR_ENV = "PQVIEWER_MOLDESCRIPTOR"
TOPOLOGY_ENV = "PQVIEWER_TOPOLOGY"

MAX_UPLOAD_FILES = 8
MAX_UPLOAD_FILE_BYTES = 2 * 1024**3
MAX_UPLOAD_TOTAL_BYTES = 4 * 1024**3
UPLOAD_CHUNK_BYTES = 1024**2
DATASET_GENERATION_FIELD = "dataset_generation"
STALE_DATASET_DETAIL = "Trajectory changed. Reload the manifest."

_UPLOAD_FIELDS = {
    "files",
    "trajectory",
    "forces",
    "velocities",
    "charges",
    "energy",
    "info",
    "moldescriptor",
    "topology",
}
_UPLOAD_EXTENSIONS = {
    "trajectory": (".extended.xyz", ".extxyz", ".xyz"),
    "forces": (".force", ".frc", ".forces"),
    "velocities": (".vel", ".velocs", ".velocity"),
    "charges": (".charge", ".chrg", ".charges"),
    "energy": (".en",),
    "info": (".info",),
}


class _UploadLimitExceeded(MultiPartException):
    """Raised while parsing an oversized multipart upload."""


class _LimitedMultiPartParser(MultiPartParser):
    """Enforce file limits while the request stream is parsed."""

    def __init__(
        self,
        *args: Any,
        max_file_bytes: int,
        max_total_bytes: int,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self.max_file_bytes = max_file_bytes
        self.max_total_bytes = max_total_bytes
        self._current_file_bytes = 0
        self._total_file_bytes = 0

    def on_part_begin(self) -> None:
        super().on_part_begin()
        self._current_file_bytes = 0

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        if self._current_part.file is not None:
            chunk_bytes = end - start
            self._current_file_bytes += chunk_bytes
            self._total_file_bytes += chunk_bytes
            if self._current_file_bytes > self.max_file_bytes:
                raise _UploadLimitExceeded("Upload file is too large")
            if self._total_file_bytes > self.max_total_bytes:
                raise _UploadLimitExceeded("Upload is too large")
        super().on_part_data(data, start, end)


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
    forces_path: str | Path | None = None,
    velocities_path: str | Path | None = None,
    charges_path: str | Path | None = None,
    moldescriptor_path: str | Path | None = None,
    topology_path: str | Path | None = None,
    dataset: Any | None = None,
    frame_encoder: Callable[[Any], bytes] = encode_frame,
    static_dir: str | Path | None = None,
) -> FastAPI:
    """Create an application with an optional initial trajectory."""

    if dataset is None:
        sidecar_paths = (
            energy_path,
            info_path,
            forces_path,
            velocities_path,
            charges_path,
            moldescriptor_path,
            topology_path,
        )
        if trajectory_path is None and any(path is not None for path in sidecar_paths):
            raise ValueError("Sidecar files require an initial trajectory.")
        dataset = (
            PQTrajectoryDataset(
                trajectory_path,
                energy_path=energy_path,
                info_path=info_path,
                forces_path=forces_path,
                velocities_path=velocities_path,
                charges_path=charges_path,
                moldescriptor_path=moldescriptor_path,
                topology_path=topology_path,
            )
            if trajectory_path is not None
            else EmptyTrajectoryDataset()
        )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            yield
        finally:
            _cleanup_upload(app)

    application = FastAPI(title="PQViewer", lifespan=lifespan)
    application.state.dataset = dataset
    application.state.dataset_lock = RLock()
    application.state.dataset_generation = _new_dataset_generation()
    application.state.upload_temp = None
    application.state.open_generation = 0

    @application.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/api/manifest")
    def manifest(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        with application.state.dataset_lock:
            return _manifest_with_generation(
                application.state.dataset.manifest(),
                application.state.dataset_generation,
            )

    @application.get("/api/frames/{frame_index}")
    def frame(
        frame_index: int,
        dataset_generation: str | None = None,
        coordinates: Literal["source", "unwrapped"] = "source",
    ) -> Response:
        try:
            with application.state.dataset_lock:
                if (
                    dataset_generation is not None
                    and dataset_generation != application.state.dataset_generation
                ):
                    raise HTTPException(
                        status_code=409,
                        detail=STALE_DATASET_DETAIL,
                    )
                if coordinates == "source":
                    value = application.state.dataset.get_frame(frame_index)
                else:
                    value = application.state.dataset.get_frame(
                        frame_index,
                        coordinates=coordinates,
                    )
        except IndexError as error:
            raise HTTPException(status_code=404, detail="Frame not found.") from error

        return Response(
            frame_encoder(value),
            media_type="application/octet-stream",
            headers={"Cache-Control": "no-store"},
        )

    @application.post("/api/refresh")
    def refresh(response: Response) -> dict[str, Any]:
        with application.state.dataset_lock:
            current = application.state.dataset
            added_frames = current.refresh()
            application.state.dataset_generation = _new_dataset_generation()
            refreshed_manifest = _manifest_with_generation(
                current.manifest(),
                application.state.dataset_generation,
            )
        refreshed_manifest["added_frames"] = added_frames
        response.headers["Cache-Control"] = "no-store"
        return refreshed_manifest

    @application.post("/api/open")
    async def open_dataset(request: Request, response: Response) -> dict[str, Any]:
        with application.state.dataset_lock:
            application.state.open_generation += 1
            generation = application.state.open_generation
        form = None
        try:
            parser = _LimitedMultiPartParser(
                request.headers,
                request.stream(),
                max_files=MAX_UPLOAD_FILES,
                max_fields=0,
                max_part_size=UPLOAD_CHUNK_BYTES,
                max_file_bytes=MAX_UPLOAD_FILE_BYTES,
                max_total_bytes=MAX_UPLOAD_TOTAL_BYTES,
            )
            form = await parser.parse()
            uploads = _uploaded_files(form.multi_items())
            temporary = TemporaryDirectory(prefix="pqviewer-upload-")
            try:
                paths = await _store_uploads(uploads, Path(temporary.name))
                candidate, opened_manifest = await run_in_threadpool(
                    _open_uploaded_dataset,
                    paths,
                )
            except BaseException:
                temporary.cleanup()
                raise
        except _UploadLimitExceeded as error:
            raise HTTPException(status_code=413, detail=error.message) from error
        except MultiPartException as error:
            raise HTTPException(status_code=400, detail=error.message) from error
        except HTTPException:
            raise
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(
                status_code=400,
                detail=f"Could not open trajectory: {error}",
            ) from error
        finally:
            if form is not None:
                await form.close()

        with application.state.dataset_lock:
            if generation != application.state.open_generation:
                temporary.cleanup()
                raise HTTPException(
                    status_code=409,
                    detail="A newer trajectory open request superseded this one.",
                )
            previous_temp = application.state.upload_temp
            application.state.dataset = candidate
            application.state.dataset_generation = _new_dataset_generation()
            application.state.upload_temp = temporary
            opened_manifest = _manifest_with_generation(
                opened_manifest,
                application.state.dataset_generation,
            )
        if previous_temp is not None:
            previous_temp.cleanup()
        response.headers["Cache-Control"] = "no-store"
        return opened_manifest

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


def _new_dataset_generation() -> str:
    return secrets.token_urlsafe(18)


def _manifest_with_generation(
    manifest: dict[str, Any],
    generation: str,
) -> dict[str, Any]:
    result = dict(manifest)
    result[DATASET_GENERATION_FIELD] = generation
    return result


def create_app_from_env() -> FastAPI:
    """Create the application configured by the CLI environment."""

    trajectory_path = os.environ.get(TRAJECTORY_ENV) or None
    return create_app(
        trajectory_path,
        energy_path=os.environ.get(ENERGY_ENV),
        info_path=os.environ.get(INFO_ENV),
        forces_path=os.environ.get(FORCES_ENV),
        velocities_path=os.environ.get(VELOCITIES_ENV),
        charges_path=os.environ.get(CHARGES_ENV),
        moldescriptor_path=os.environ.get(MOLDESCRIPTOR_ENV),
        topology_path=os.environ.get(TOPOLOGY_ENV),
    )


def _uploaded_files(items: list[tuple[str, Any]]) -> dict[str, UploadFile]:
    uploads: dict[str, UploadFile] = {}
    for field, value in items:
        if field not in _UPLOAD_FIELDS:
            raise ValueError(f"Unknown upload field: {field}")
        if not isinstance(value, UploadFile):
            raise ValueError(f"Upload field {field} must be a file")
        role = _classify_upload(value.filename) if field == "files" else field
        if role in uploads:
            raise ValueError(f"More than one {role} file was provided")
        uploads[role] = value
    if "trajectory" not in uploads:
        raise ValueError("Upload field trajectory is required")
    if "info" in uploads and "energy" not in uploads:
        raise ValueError("An info file requires an energy file")
    return uploads


def _classify_upload(filename: str | None) -> str:
    name = _safe_name(filename)
    lowered = name.lower()
    for role, extensions in _UPLOAD_EXTENSIONS.items():
        if any(lowered.endswith(extension) for extension in extensions):
            return role
    if lowered.endswith((".top", ".topology")):
        return "topology"
    if "moldescriptor" in lowered or lowered.endswith((".mol", ".moldescriptor")):
        return "moldescriptor"
    raise ValueError(f"Unsupported upload file: {name}")


async def _store_uploads(
    uploads: dict[str, UploadFile],
    directory: Path,
) -> dict[str, Path]:
    names: set[str] = set()
    paths: dict[str, Path] = {}
    total = 0
    trajectory_name = _safe_name(uploads["trajectory"].filename)
    trajectory_stem = _validated_stem("trajectory", trajectory_name)

    for field, upload in uploads.items():
        name = _safe_name(upload.filename)
        stem = _validated_stem(field, name)
        if field in {"forces", "velocities", "charges", "energy", "info"}:
            if stem.casefold() != trajectory_stem.casefold():
                raise ValueError(f"{field} file must match the trajectory name")
        normalized_name = name.casefold()
        if normalized_name in names:
            raise ValueError(f"Duplicate upload filename: {name}")
        names.add(normalized_name)

        target = directory / name
        written = 0
        with target.open("xb") as handle:
            while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
                written += len(chunk)
                total += len(chunk)
                if written > MAX_UPLOAD_FILE_BYTES:
                    raise HTTPException(status_code=413, detail=f"{field} file is too large")
                if total > MAX_UPLOAD_TOTAL_BYTES:
                    raise HTTPException(status_code=413, detail="Upload is too large")
                handle.write(chunk)
        paths[field] = target
    return paths


def _open_uploaded_dataset(
    paths: dict[str, Path],
) -> tuple[PQTrajectoryDataset, dict[str, Any]]:
    candidate = PQTrajectoryDataset(
        paths["trajectory"],
        energy_path=paths.get("energy"),
        info_path=paths.get("info"),
        forces_path=paths.get("forces"),
        velocities_path=paths.get("velocities"),
        charges_path=paths.get("charges"),
        moldescriptor_path=paths.get("moldescriptor"),
        topology_path=paths.get("topology"),
    )
    return candidate, candidate.manifest()


def _safe_name(filename: str | None) -> str:
    name = PurePosixPath((filename or "").replace("\\", "/")).name
    if not name or name in {".", ".."} or len(name.encode("utf-8")) > 255:
        raise ValueError("Upload filename is invalid")
    if any(ord(character) < 32 for character in name):
        raise ValueError("Upload filename is invalid")
    return name


def _validated_stem(field: str, filename: str) -> str:
    extensions = _UPLOAD_EXTENSIONS.get(field)
    if extensions is None:
        return Path(filename).stem
    lowered = filename.lower()
    for extension in extensions:
        if lowered.endswith(extension):
            return filename[: -len(extension)]
    expected = ", ".join(extensions)
    raise ValueError(f"{field} file must use one of: {expected}")


def _cleanup_upload(application: FastAPI) -> None:
    temporary = getattr(application.state, "upload_temp", None)
    if temporary is not None:
        temporary.cleanup()
        application.state.upload_temp = None
