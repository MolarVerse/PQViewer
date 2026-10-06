# Web demo

The [hosted viewer](https://molarverse.github.io/PQViewer/viewer/) opens a fixed
SrTiO3 dataset without a Python server.

| Task | Try |
| --- | --- |
| Inspect geometry | Rotate, zoom, select atoms, and inspect cell parameters |
| Show coordination polyhedra | Open **Search** (`Cmd/Ctrl+K` or `/`) and search for `Polyhedra` |
| Edit lattice vectors | Search for `edit lattice vectors` |
| Save the current result | Download edited EXTXYZ or export a PNG/TIFF figure |

Polyhedra depict visible coordination geometry. Pair-distribution and
coordination curves require a local PQAnalysis process and are unavailable in
the static demo.

Edits remain in the browser and reset on reload. The demo does not upload a
structure, open arbitrary local files, follow growing trajectories, or join
restart runs.

To use your data, follow [Getting started](getting-started.md). For cluster data,
use [Remote access](remote-access.md).
