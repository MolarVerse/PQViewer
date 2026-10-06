# PQViewer

Inspect a structure, select atoms, and follow measurements through a trajectory.

![SrTiO3 coordination polyhedra with the View inspector open](assets/screenshots/viewer-workspace.png)

```bash
pqviewer trajectory.xyz
```

Python 3.12+ and WebGL 2. [Install or try the water trajectory](getting-started.md),
or [open the SrTiO3 demo](https://molarverse.github.io/PQViewer/viewer/).

| Task | Guide |
| --- | --- |
| View, select and measure | [Visual GUI guide](viewer-guide.md) |
| Open files and check units | [Getting started](getting-started.md), [Conventions](data-and-conventions.md) |
| Plot a trajectory or pair distribution | [Analysis](trajectory-analysis.md) |
| Save a scientific figure | [Figures and recipes](figures-and-recipes.md) |
| Connect from a cluster or home VPN | [Remote access](remote-access.md) |

## Scientific example

```{figure} assets/renders/acof-framework.png
:alt: ACOF framework viewed in a triclinic cell
:width: 85%

ACOF rendered in PQViewer. See [periodic conventions](data-and-conventions.md#centered-periodic-cells)
for the distinction between centred wrapping and shortest-image geometry.
```

ACOF comes from PQAnalysis; SrTiO3 and water are synthetic fixtures.
See [example provenance](https://github.com/MolarVerse/PQViewer/blob/main/examples/README.md).
Figure recipes and their coordinate sources are linked in [Figures and recipes](figures-and-recipes.md).

PQViewer is in public beta; file and Python interfaces may change before 1.0.

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
