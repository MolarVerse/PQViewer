"""Command-line entry point for PQViewer."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import os
from pathlib import Path
from threading import Timer
from typing import Iterator
import webbrowser

import uvicorn

from .app import ENERGY_ENV, INFO_ENV, TRAJECTORY_ENV, create_app


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""

    parser = argparse.ArgumentParser(
        prog="pqviewer",
        description="Open a molecular trajectory.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("path", type=Path, help="Trajectory file to open.")
    parser.add_argument("--energy", type=Path, help="Optional PQ energy file.")
    parser.add_argument("--info", type=Path, help="Optional PQ info file.")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Server host.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Server port.")
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser.")
    parser.add_argument("--reload", action="store_true", help="Reload after code changes.")
    return parser


def main(argv: list[str] | None = None) -> None:
    """Run PQViewer."""

    parser = build_parser()
    args = parser.parse_args(argv)

    _require_file(parser, args.path, "trajectory")
    if args.info is not None and args.energy is None:
        parser.error("--info requires --energy.")
    if args.energy is not None:
        _require_file(parser, args.energy, "energy")
    if args.info is not None:
        _require_file(parser, args.info, "info")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535.")

    try:
        application = create_app(
            args.path,
            energy_path=args.energy,
            info_path=args.info,
        )
        application.state.dataset.manifest()
    except Exception as error:  # pylint: disable=broad-exception-caught
        parser.error(f"Could not open trajectory: {error}")

    if not args.no_open:
        _open_browser_later(_browser_url(args.host, args.port))

    if args.reload:
        with _source_environment(args.path, args.energy, args.info):
            uvicorn.run(
                "pqviewer.app:create_app_from_env",
                factory=True,
                host=args.host,
                port=args.port,
                reload=True,
            )
        return

    uvicorn.run(
        application,
        host=args.host,
        port=args.port,
        reload=False,
    )


def _require_file(parser: argparse.ArgumentParser, path: Path, label: str) -> None:
    if not path.is_file():
        parser.error(f"{label.capitalize()} file not found: {path}")


def _set_source_environment(
    trajectory_path: Path,
    energy_path: Path | None,
    info_path: Path | None,
) -> None:
    os.environ[TRAJECTORY_ENV] = str(trajectory_path.resolve())
    _set_optional_environment(ENERGY_ENV, energy_path)
    _set_optional_environment(INFO_ENV, info_path)


@contextmanager
def _source_environment(
    trajectory_path: Path,
    energy_path: Path | None,
    info_path: Path | None,
) -> Iterator[None]:
    names = (TRAJECTORY_ENV, ENERGY_ENV, INFO_ENV)
    previous = {name: os.environ.get(name) for name in names}
    _set_source_environment(trajectory_path, energy_path, info_path)
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def _set_optional_environment(name: str, path: Path | None) -> None:
    if path is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = str(path.resolve())


def _browser_url(host: str, port: int) -> str:
    browser_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    if ":" in browser_host and not browser_host.startswith("["):
        browser_host = f"[{browser_host}]"
    return f"http://{browser_host}:{port}"


def _open_browser_later(url: str) -> None:
    timer = Timer(0.75, webbrowser.open, args=(url,))
    timer.daemon = True
    timer.start()


if __name__ == "__main__":
    main()
