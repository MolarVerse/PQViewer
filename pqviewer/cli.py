"""Command-line entry point for PQViewer."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import os
from pathlib import Path
import sys
from threading import Timer
from typing import Iterator
import webbrowser

import uvicorn

from .app import (
    CHARGES_ENV,
    ENERGY_ENV,
    FORCES_ENV,
    INFO_ENV,
    MOLDESCRIPTOR_ENV,
    RECIPE_ENV,
    TOPOLOGY_ENV,
    TRAJECTORY_ENV,
    VELOCITIES_ENV,
    create_app,
)
from .recipe import is_figure_recipe_path, open_figure_recipe_dataset


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""

    parser = argparse.ArgumentParser(
        prog="pqviewer",
        description="Open molecular structures and trajectories.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "path",
        nargs="?",
        help=(
            "Trajectory, PQ input, run directory, or path@start:stop:step "
            "to open."
        ),
    )
    parser.add_argument("--energy", type=Path, help="Optional PQ energy file.")
    parser.add_argument("--info", type=Path, help="Optional PQ info file.")
    parser.add_argument("--forces", type=Path, help="Optional PQ force file.")
    parser.add_argument("--velocities", type=Path, help="Optional PQ velocity file.")
    parser.add_argument("--charges", type=Path, help="Optional PQ charge file.")
    parser.add_argument(
        "--moldescriptor",
        type=Path,
        help="Optional PQ moldescriptor file.",
    )
    parser.add_argument("--topology", type=Path, help="Optional bonded topology file.")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Server host.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Server port.")
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser.")
    parser.add_argument("--reload", action="store_true", help="Reload after code changes.")
    return parser


def main(argv: list[str] | None = None) -> None:
    """Run PQViewer."""

    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments[:1] == ["render"]:
        from .render_cli import main as render_main

        render_main(arguments[1:])
        return
    parser = build_parser()
    args = parser.parse_args(arguments)
    source = _source_argument(args.path)
    recipe_path: Path | None = None
    initial_recipe = None
    recipe_dataset = None
    if source is not None and is_figure_recipe_path(source):
        recipe_path = Path(source).expanduser().resolve()
        try:
            initial_recipe, recipe_dataset = open_figure_recipe_dataset(recipe_path)
            source = None
        except (FileNotFoundError, ValueError) as error:
            parser.error(str(error))

    if args.info is not None and args.energy is None:
        parser.error("--info requires --energy.")
    if args.energy is not None:
        _require_file(parser, args.energy, "energy")
    if args.info is not None:
        _require_file(parser, args.info, "info")
    if args.forces is not None:
        _require_file(parser, args.forces, "force")
    if args.velocities is not None:
        _require_file(parser, args.velocities, "velocity")
    if args.charges is not None:
        _require_file(parser, args.charges, "charge")
    if args.moldescriptor is not None:
        _require_file(parser, args.moldescriptor, "moldescriptor")
    if args.topology is not None:
        _require_file(parser, args.topology, "topology")
    if recipe_path is not None and any(
        value is not None
        for value in (
            args.energy,
            args.info,
            args.forces,
            args.velocities,
            args.charges,
            args.moldescriptor,
            args.topology,
        )
    ):
        parser.error("A figure recipe already defines its companion files.")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535.")

    try:
        application = create_app(
            source,
            energy_path=args.energy,
            info_path=args.info,
            forces_path=args.forces,
            velocities_path=args.velocities,
            charges_path=args.charges,
            moldescriptor_path=args.moldescriptor,
            topology_path=args.topology,
            dataset=recipe_dataset,
            initial_recipe=initial_recipe,
        )
        application.state.dataset.manifest()
    except Exception as error:  # pylint: disable=broad-exception-caught
        parser.error(f"Could not open source: {error}")

    if not args.no_open:
        _open_browser_later(_browser_url(args.host, args.port))

    if args.reload:
        with _source_environment(
            source,
            args.energy,
            args.info,
            args.forces,
            args.velocities,
            args.charges,
            args.moldescriptor,
            args.topology,
            recipe_path,
        ):
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


def _source_argument(value: str | None) -> str | Path | None:
    if value is None:
        return None
    path = Path(value).expanduser()
    return path.resolve() if path.exists() else value


def _set_source_environment(
    trajectory_path: str | Path | None,
    energy_path: Path | None,
    info_path: Path | None,
    forces_path: Path | None,
    velocities_path: Path | None,
    charges_path: Path | None,
    moldescriptor_path: Path | None = None,
    topology_path: Path | None = None,
    recipe_path: Path | None = None,
) -> None:
    if trajectory_path is None:
        os.environ.pop(TRAJECTORY_ENV, None)
    else:
        os.environ[TRAJECTORY_ENV] = str(trajectory_path)
    _set_optional_environment(ENERGY_ENV, energy_path)
    _set_optional_environment(INFO_ENV, info_path)
    _set_optional_environment(FORCES_ENV, forces_path)
    _set_optional_environment(VELOCITIES_ENV, velocities_path)
    _set_optional_environment(CHARGES_ENV, charges_path)
    _set_optional_environment(MOLDESCRIPTOR_ENV, moldescriptor_path)
    _set_optional_environment(TOPOLOGY_ENV, topology_path)
    _set_optional_environment(RECIPE_ENV, recipe_path)


@contextmanager
def _source_environment(
    trajectory_path: str | Path | None,
    energy_path: Path | None,
    info_path: Path | None,
    forces_path: Path | None,
    velocities_path: Path | None,
    charges_path: Path | None,
    moldescriptor_path: Path | None = None,
    topology_path: Path | None = None,
    recipe_path: Path | None = None,
) -> Iterator[None]:
    names = (
        TRAJECTORY_ENV,
        ENERGY_ENV,
        INFO_ENV,
        FORCES_ENV,
        VELOCITIES_ENV,
        CHARGES_ENV,
        MOLDESCRIPTOR_ENV,
        TOPOLOGY_ENV,
        RECIPE_ENV,
    )
    previous = {name: os.environ.get(name) for name in names}
    _set_source_environment(
        trajectory_path,
        energy_path,
        info_path,
        forces_path,
        velocities_path,
        charges_path,
        moldescriptor_path,
        topology_path,
        recipe_path,
    )
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
