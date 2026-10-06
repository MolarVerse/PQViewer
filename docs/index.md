# PQViewer

Inspect molecular structures and trajectories, measure periodic geometry,
calculate pair distributions, and export figures.

## Start here

[Install and open your first trajectory](getting-started.md). For a browser-only
example, [open the SrTiO3 demo](https://molarverse.github.io/PQViewer/viewer/) and read its [limits](web-demo.md).

```{figure} assets/screenshots/viewer-workspace.png
:alt: SrTiO3 coordination polyhedra with the View inspector open
:class: pq-workspace
:width: 100%

SrTiO3 in a centred periodic cell. Polyhedra show the visible coordination
geometry.
```

## Manual

| Task | Read |
| --- | --- |
| Install, open PQ runs, and attach companions | [Getting started](getting-started.md) |
| Check source identity, units, and periodic conventions | [Data and conventions](data-and-conventions.md) |
| Navigate, select, measure, and edit | [Viewer guide](viewer-guide.md) |
| Plot trajectories, `g(r)`, and coordination | [Trajectory analysis](trajectory-analysis.md) |
| Save figures and source-validated recipes | [Figures and recipes](figures-and-recipes.md) |
| Work on a server, compute node, or home VPN | [Remote access](remote-access.md) |
| Use a notebook or Python dataset | [Jupyter](jupyter.md), [Python API](python-api.md) |
| Resolve file, browser, and rendering problems | [Troubleshooting](troubleshooting.md) |

## Scientific examples

The repository includes small fixtures for periodic geometry and trajectory
inspection. Run these commands from a
[source checkout](https://github.com/MolarVerse/PQViewer):

| Example | Inspect | Command |
| --- | --- | --- |
| Water | Three-frame trajectory | `pqviewer examples/water.xyz` |
| Periodic crossing | Wrapped and unwrapped motion | `pqviewer examples/periodic-crossing.extxyz` |
| SrTiO3 | Centred cell and TiO6 coordination geometry | `pqviewer examples/strontium-titanate.extxyz` |
| ACOF | Triclinic framework | `pqviewer examples/acof-triclinic.xyz` |

Synthetic fixtures are covered by the repository's MIT License. The ACOF
trajectory comes from PQAnalysis; see the
[example provenance](https://github.com/MolarVerse/PQViewer/blob/main/examples/README.md).

```{figure} assets/renders/acof-framework.png
:alt: ACOF framework viewed in a triclinic cell
:width: 85%

ACOF rendered with PQViewer. A skewed cell requires distinguishing centred
wrapping from shortest-image measurements; see [periodic conventions](data-and-conventions.md#centered-periodic-cells).
```

Example figure recipes are available for
{download}`periodic water <assets/recipes/water-box.pqfigure.json>` and
{download}`SrTiO3 <assets/recipes/strontium-titanate.pqfigure.json>`.
In a checkout, keep the sibling `assets/sources/` directory with the recipes.
Downloading a recipe alone omits its coordinates; see
[Figures and recipes](figures-and-recipes.md).

PQViewer is in public beta. File and Python interfaces may change before 1.0.

```{toctree}
:hidden:
:maxdepth: 2
:caption: Contents

getting-started
data-and-conventions
viewer-guide
trajectory-analysis
figures-and-recipes
remote-access
jupyter
python-api
web-demo
troubleshooting
```
