# Web demo

The [hosted viewer](https://molarverse.github.io/PQViewer/viewer/) packages the
PQViewer frontend and a SrTiO<sub>3</sub> perovskite dataset as static files. It runs
without a Python server.

## Available in the demo

- rotation, zoom, selection, and keyboard navigation
- atom coordinates, element identity, cell parameters, vectors, and periodic
  axes
- atoms, inferred bonds, cell, polyhedra, and surfaces
- View, Edit, and Analyze tools
- atom, setting, and command search
- edited EXTXYZ download
- PNG and TIFF output through the independent publication renderer

Use the visible **Search** field or press `Cmd/Ctrl+K` or `/`. Search for
**Polyhedra** to inspect complete TiO<sub>6</sub> octahedra, or search for
`edit lattice vectors` to open the cell matrix.

Edits remain in the browser and reset when the page reloads. No structure is
uploaded by the static demo.

## Local-only features

GitHub Pages has no Python process. The demo cannot open arbitrary local files,
follow a growing trajectory, join PQ restart runs, or calculate pair
distribution and coordination curves through PQAnalysis.

Follow [Getting started](getting-started.md) to run PQViewer locally with those
features. The local server binds to `127.0.0.1` by default.

## Deployment

The Pages workflow builds this documentation and the fixed-dataset viewer as
one artifact. Pushes to `main` publish it through the repository's GitHub Pages
environment.
