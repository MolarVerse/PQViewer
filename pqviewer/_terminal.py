"""PQViewer identity and application-scoped terminal events."""

from importlib.metadata import version
import json
import logging
from pathlib import Path
from typing import Any

from ._design_terminal import Terminal


_COLORS = json.loads(Path(__file__).with_name("_design_tokens.json").read_text())["color"]
_QUIET_LOG = logging.Logger("PQViewer")
_QUIET_LOG.addHandler(logging.NullHandler())
_QUIET_LOG.propagate = False


def make_terminal() -> Terminal:
    return Terminal("PQViewer", version("MolarVerse-PQViewer"), _COLORS)


def event_log(application: Any) -> logging.Logger:
    """Library and notebook applications keep their own quiet event scope."""
    return getattr(application.state, "event_log", None) or _QUIET_LOG
