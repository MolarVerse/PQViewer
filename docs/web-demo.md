# Interactive web demo

The Pages-ready PQViewer demo uses the same bundled React and 3Dmol.js frontend
as the local application. Its SrTiO3 perovskite manifest and binary frame
packet are static assets, so it can run entirely on GitHub Pages.

The target URL is
[`molarverse.github.io/PQViewer/viewer/`](https://molarverse.github.io/PQViewer/viewer/).
It becomes available after Pages is enabled for the repository.

## What works

- 3D rotation, zoom, selection, and keyboard navigation
- atom coordinates, element identity, cell parameters, vectors, and periodic
  axes, with edited EXTXYZ download
- explicit View, Edit, and Analyze tools with the same responsive inspector as
  the local application
- atoms, bonds, cells, polyhedra, surfaces, and scientific overlays present in
  the bundled frame
- atom, setting, and command search with keyboard shortcuts
- client-side screenshots and the separate high-quality figure path

Use the visible **Search** control or press `Cmd/Ctrl+K` or `/`. Search for
**Polyhedra** in the bundled perovskite to inspect complete TiO6 octahedra, or
search `edit lattice vectors` to jump directly to the cell matrix.

## What stays local

GitHub Pages has no Python process. The demo therefore cannot open arbitrary
local files, follow a growing trajectory, join PQ restart runs, or calculate
pair-distribution and coordination curves through PQAnalysis. Install and run
PQViewer for those operations:

```bash
python -m pip install .
pqviewer trajectory.xyz
```

No structure is uploaded by the static demo. The local application also binds
to `127.0.0.1` by default.

## Deployment

The Pages workflow builds the Sphinx documentation at the site root and a
read-only frontend under `/viewer/`. It packs a bounded, path-sanitized dataset
with `scripts/build_static_demo.py`; the frontend switches from `/api` requests
to those local assets at build time.

The repository's Pages source must permit GitHub Actions. GitHub Pages for a
private repository also requires a paid GitHub plan; GitHub Free can publish
the site after the repository is made public. On the first eligible run, the
workflow requests Pages enablement and deploys one combined artifact.
