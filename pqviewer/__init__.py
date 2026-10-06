"""PQAnalysis-backed molecular trajectory viewing."""

import logging

# Keep PQAnalysis's import-time basicConfig from configuring an embedding app.
_root_log = logging.getLogger()
_import_handler = logging.NullHandler() if not _root_log.handlers else None
if _import_handler is not None:
    _root_log.addHandler(_import_handler)
try:
    from .app import create_app
    from .data import FrameData, FrameKey, PQTrajectoryDataset
    from .notebook import NotebookViewer, view
    from .packet import encode_frame
    from .sources import IndexedFrameSource, RunDataset, open_run_dataset
finally:
    if _import_handler is not None:
        _root_log.removeHandler(_import_handler)

__all__ = [
    "FrameData",
    "FrameKey",
    "IndexedFrameSource",
    "NotebookViewer",
    "PQTrajectoryDataset",
    "RunDataset",
    "create_app",
    "encode_frame",
    "open_run_dataset",
    "view",
]
