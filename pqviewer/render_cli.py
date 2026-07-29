"""Deterministic figure rendering through the packaged browser."""

from __future__ import annotations

import argparse
import math
from pathlib import Path
import socket
from threading import Thread
import time
from typing import Any

import uvicorn

from .app import create_app
from .recipe import open_figure_recipe_dataset


_OUTPUT_FORMATS = {
    ".png": "png",
    ".tif": "tiff",
    ".tiff": "tiff",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pqviewer render",
        description="Render a saved PQViewer figure recipe.",
    )
    parser.add_argument("recipe", type=Path, help="Figure recipe to render.")
    parser.add_argument("-o", "--output", type=Path, required=True)
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--dpi", type=int)
    parser.add_argument("--format", choices=("png", "tiff"))
    parser.add_argument("--transparent", action="store_true")
    parser.add_argument("--timeout", type=float, default=120.0)
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        recipe, dataset = open_figure_recipe_dataset(args.recipe)
        output = args.output.expanduser().resolve()
        output_format = resolve_output_format(output, args.format)
    except Exception as error:
        detail = str(error).strip().splitlines()[0] or type(error).__name__
        parser.error(detail)
    overrides = {
        key: value
        for key, value in {
            "width": args.width,
            "height": args.height,
            "dpi": args.dpi,
            "format": output_format,
            "transparent": True if args.transparent else None,
        }.items()
        if value is not None
    }
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        render_recipe(
            recipe,
            dataset,
            output,
            overrides=overrides,
            timeout=args.timeout,
        )
    except (OSError, RuntimeError, TimeoutError, ValueError) as error:
        parser.exit(1, f"pqviewer render: {error}\n")


def resolve_output_format(output: Path, requested: str | None = None) -> str:
    """Resolve and validate a raster output format."""
    inferred = _OUTPUT_FORMATS.get(output.suffix.casefold())
    if inferred is None:
        raise ValueError("output must use .png, .tif, or .tiff")
    if requested is not None and requested != inferred:
        raise ValueError(
            f"--format {requested} does not match {output.suffix or 'the output path'}"
        )
    return requested or inferred


def render_recipe(
    recipe: dict[str, Any],
    dataset: Any,
    output: Path,
    *,
    overrides: dict[str, Any] | None = None,
    timeout: float = 120.0,
) -> None:
    """Render one recipe with the same browser path as interactive export."""
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("render timeout must be a positive finite number")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise RuntimeError(
            "headless rendering requires pqviewer3d[render]"
        ) from error

    application = create_app(dataset=dataset, initial_recipe=recipe)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server = None
    thread = None
    deadline = time.monotonic() + timeout
    try:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = int(listener.getsockname()[1])
        server = uvicorn.Server(
            uvicorn.Config(
                application,
                host="127.0.0.1",
                port=port,
                log_level="warning",
            )
        )
        thread = Thread(
            target=server.run,
            kwargs={"sockets": [listener]},
            daemon=True,
        )
        thread.start()
        while not server.started:
            if not thread.is_alive():
                raise RuntimeError("headless render server failed to start")
            if time.monotonic() >= deadline:
                raise TimeoutError("headless render server did not start")
            time.sleep(0.01)

        try:
            with sync_playwright() as playwright:
                launch_timeout = _remaining_ms(deadline, "starting Chromium")
                try:
                    browser = playwright.chromium.launch(
                        headless=True,
                        args=["--use-angle=swiftshader", "--disable-gpu-sandbox"],
                        timeout=launch_timeout,
                    )
                except Exception as error:
                    raise RuntimeError(
                        "Chromium is unavailable; run playwright install chromium"
                    ) from error
                try:
                    page = browser.new_page()
                    page.goto(
                        f"http://127.0.0.1:{port}/?headless=1",
                        wait_until="networkidle",
                        timeout=_remaining_ms(deadline, "opening the viewer"),
                    )
                    page.wait_for_function(
                        """() => (
                            window.pqviewerFigure?.ready === true
                            || Boolean(window.pqviewerFigure?.error)
                        )""",
                        timeout=_remaining_ms(
                            deadline,
                            "restoring the figure recipe",
                        ),
                    )
                    bridge_error = page.evaluate(
                        "() => window.pqviewerFigure?.error ?? null"
                    )
                    if bridge_error:
                        raise RuntimeError(
                            "figure recipe could not be restored: "
                            f"{bridge_error}"
                        )
                    with page.expect_download(
                        timeout=_remaining_ms(deadline, "rendering the figure"),
                    ) as pending:
                        page.evaluate(
                            "(options) => window.pqviewerFigure.export(options)",
                            overrides or {},
                        )
                    pending.value.save_as(output)
                finally:
                    browser.close()
        except (RuntimeError, TimeoutError, ValueError):
            raise
        except Exception as error:
            detail = str(error).strip().splitlines()[0] or type(error).__name__
            raise RuntimeError(f"browser export failed: {detail}") from error
    finally:
        if server is not None:
            server.should_exit = True
        if thread is not None:
            thread.join(timeout=10)
        listener.close()

    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("headless rendering did not produce an output file")


def _remaining_ms(deadline: float, action: str) -> int:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError(f"headless render timed out while {action}")
    return max(1, round(remaining * 1000))
