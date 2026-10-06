# PQViewer

Inspect PQ molecular structures and trajectories in a desktop browser. Optional
ASE support adds other file formats and Python objects.

## Install and open a trajectory

Use Python 3.12 or newer and a browser with WebGL 2. The interface is included
in the Python package.

```bash
python -m pip install MolarVerse-PQViewer
pqviewer trajectory.xyz
```

Replace `trajectory.xyz` with your file. To try a small synthetic trajectory:

```bash
cat > water.xyz <<'XYZ'
3
Frame 1
O  0.0000  0.0000  0.0000
H  0.7586  0.0000  0.5043
H -0.7586  0.0000  0.5043
3
Frame 2
O  0.0000  0.0000  0.0200
H  0.7690  0.0000  0.4870
H -0.7690  0.0000  0.4870
XYZ
pqviewer water.xyz
```

Drag to rotate; click an atom, then Shift-click others in measurement order.
The timeline changes frames. **Search** (`Cmd/Ctrl+K` or `/`) finds commands.

![SrTiO3 structure with coordination polyhedra and the View inspector](docs/assets/screenshots/viewer-workspace.png)

## Scientific use

| Task | Convention or requirement | Manual |
| --- | --- | --- |
| Inspect structures and trajectories | Stable atom count and element order; optional ASE support | [Open data](https://molarverse.github.io/PQViewer/getting-started.html) |
| Display periodic images | Centred fractional cell `[-0.5, 0.5)`; enabled periodic axes only | [Data and conventions](https://molarverse.github.io/PQViewer/data-and-conventions.html) |
| Measure distances, angles, and dihedrals | Ordered selections; minimum-image geometry by default | [Viewer guide](https://molarverse.github.io/PQViewer/viewer-guide.html) |
| Calculate `g(r)` and coordination | File-backed data with a full three-dimensional periodic cell | [Trajectory analysis](https://molarverse.github.io/PQViewer/trajectory-analysis.html) |
| Export figures and curves | PNG/TIFF figures; CSV/SVG/PDF plots; recipes validate source data | [Figures and recipes](https://molarverse.github.io/PQViewer/figures-and-recipes.html) |

For cluster use, keep the server on loopback and follow
[Remote access](https://molarverse.github.io/PQViewer/remote-access.html), including
institutional VPN and jump-host access. Source reading and analysis run on the
server; the browser receives frame and chart data. PQViewer has no HTTP
authentication.

Use the [Jupyter guide](https://molarverse.github.io/PQViewer/jupyter.html) or
[Python API](https://molarverse.github.io/PQViewer/python-api.html) for Python
workflows. The [web demo](https://molarverse.github.io/PQViewer/viewer/) uses a
fixed SrTiO3 dataset.

PQViewer is in public beta; file and Python interfaces may change before 1.0.
See [release notes](CHANGELOG.md), [citation](CITATION.cff), and
[contributing](CONTRIBUTING.md). Licensed under [MIT](LICENSE), with
[third-party notices](THIRD_PARTY_NOTICES.md).
