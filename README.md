<img src="https://raw.githubusercontent.com/MolarVerse/PQViewer/main/frontend/public/pq-logo.png" alt="PQViewer logo" width="200">

# PQViewer

[![CI](https://github.com/MolarVerse/PQViewer/actions/workflows/ci.yml/badge.svg)](https://github.com/MolarVerse/PQViewer/actions/workflows/ci.yml)
[![Documentation](https://github.com/MolarVerse/PQViewer/actions/workflows/pages.yml/badge.svg)](https://molarverse.github.io/PQViewer/)
[![Python 3.12+](https://img.shields.io/badge/Python-3.12%2B-3776AB?logo=python&logoColor=white)](https://github.com/MolarVerse/PQViewer/blob/main/pyproject.toml)
[![License: MIT](https://img.shields.io/badge/License-MIT-2f718f.svg)](https://github.com/MolarVerse/PQViewer/blob/main/LICENSE)

PQViewer opens molecular structures and trajectories from PQ in a local
browser, with optional ASE format support. It provides indexed playback,
centred periodic cells, measurements, and reproducible figure export.

[Documentation](https://molarverse.github.io/PQViewer/) ·
[Web demo](https://molarverse.github.io/PQViewer/viewer/) ·
[Jupyter example](https://github.com/MolarVerse/PQViewer/blob/main/examples/pqviewer-notebook.ipynb)

![PQViewer showing a 100-frame UMCM-9 trajectory](https://raw.githubusercontent.com/MolarVerse/PQViewer/main/docs/assets/screenshots/trajectory-workspace.png)

PQViewer is preparing for its first public beta. File and Python interfaces may
change before 1.0.

## Install

PQViewer requires Python 3.12 or newer.
The Python distribution is named `PQViewer3D`; the application, import package,
and command remain `PQViewer`, `pqviewer`, and `pqviewer`.

```bash
git clone https://github.com/MolarVerse/PQViewer.git
cd PQViewer
python3 -m venv .venv
source .venv/bin/activate
python -m pip install .
pqviewer examples/water.xyz
```

Node.js is not required. Optional ASE format support is installed with
`python -m pip install '.[ase]'`.

The CLI also accepts PQ inputs, run directories, ASE sources, and frame slices.
See [Getting started](https://molarverse.github.io/PQViewer/getting-started.html)
for examples.

## Viewer

- 3Dmol.js atoms, bonds, protein cartoons, surfaces, cells, and selections
- centred orthorhombic and triclinic cells, wrapping, and molecule reconstruction
- atom and cell editing with EXTXYZ download
- trajectory playback, measurements, analysis, forces, and collision indicators
- independent PNG and TIFF figure rendering with reusable recipes

Search atoms, settings, and commands with the central **Search** field,
`Cmd/Ctrl+K`, or `/`.

## Jupyter

```bash
python -m pip install '.[jupyter,ase]'
```

```python
from pqviewer import view

viewer = view("trajectory.xyz", height=620)
viewer
```

The notebook cell embeds the local viewer. Call `viewer.close()` when finished.
See the [Jupyter guide](https://molarverse.github.io/PQViewer/jupyter.html) for
files, ASE objects, companion data, and remote kernels.

## Project

[Contributing](https://github.com/MolarVerse/PQViewer/blob/main/CONTRIBUTING.md) ·
[Citation](https://github.com/MolarVerse/PQViewer/blob/main/CITATION.cff) ·
[Security](https://github.com/MolarVerse/PQViewer/blob/main/SECURITY.md) ·
[Changelog](https://github.com/MolarVerse/PQViewer/blob/main/CHANGELOG.md) ·
[License](https://github.com/MolarVerse/PQViewer/blob/main/LICENSE) ·
[Third-party notices](https://github.com/MolarVerse/PQViewer/blob/main/THIRD_PARTY_NOTICES.md)

PQViewer binds to `127.0.0.1` by default and does not provide authentication.
Do not expose the local server to an untrusted network.
