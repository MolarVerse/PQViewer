# PQViewer

PQViewer is a local molecular structure and trajectory viewer built on
[PQAnalysis](https://github.com/MolarVerse/PQAnalysis). It combines indexed
trajectory access, PQ-centred periodic cells, direct measurements, and
reproducible publication figures in a modern browser interface.

[Get started](getting-started.md) · [Viewer guide](viewer-guide.md) ·
[Figure guide](figures-and-recipes.md) ·
[Python API](python-api.md)

:::{note}
PQViewer is preparing for its first public beta. File and Python interfaces may
still change before 1.0.
:::

## Quick start

PQViewer requires Python 3.12 or newer.

```bash
python -m pip install .
pqviewer trajectory.xyz
```

The interface is bundled with the Python package. Node.js is not required to
install or run the viewer.

## Trajectory workspace

Playback, selection, measurements, periodic display, and figure export remain
close to the structure without crowding the molecular canvas.

```{figure} assets/screenshots/trajectory-workspace.png
:alt: PQViewer showing a 100-frame UMCM-9 trajectory
:class: pq-workspace
:width: 100%

UMCM-9 trajectory, frame 1 of 100.
```

## Documentation

::::{grid} 1 2 3 3
:gutter: 2

:::{grid-item-card} Getting started
:link: getting-started
:link-type: doc

Installation, optional integrations, and the first trajectory.
:::

:::{grid-item-card} Viewer guide
:link: viewer-guide
:link-type: doc

Navigation, selection, representations, measurements, and shortcuts.
:::

:::{grid-item-card} Data and conventions
:link: data-and-conventions
:link-type: doc

PQ runs, ASE sources, companions, units, and centred periodic cells.
:::

:::{grid-item-card} Trajectory analysis
:link: trajectory-analysis
:link-type: doc

Measurements, tracking, reference frames, and pair analysis.
:::

:::{grid-item-card} Figures and recipes
:link: figures-and-recipes
:link-type: doc

Publication output and reproducible headless rendering.
:::

:::{grid-item-card} Python API
:link: python-api
:link-type: doc

Open datasets, pass ASE objects, and create an application.
:::
::::

## Scientific systems

The same viewer and export path cover proteins, isolated molecules, periodic
water, crystals, covalent frameworks, and metal-organic frameworks.

::::{grid} 1 2 3 3
:gutter: 2

:::{grid-item-card} Protein — Crambin
:img-top: assets/renders/crambin.png
:img-alt: Crambin protein shown as a molecular cartoon

PDB 1CRN · 46 residues

+++
{download}`Figure recipe <assets/recipes/crambin.pqfigure.json>`
:::

:::{grid-item-card} Molecule — C60
:img-top: assets/renders/c60.png
:img-alt: C60 fullerene rendered as a ball-and-stick molecule

Isolated fullerene · 60 atoms

+++
{download}`Figure recipe <assets/recipes/c60.pqfigure.json>`
:::

:::{grid-item-card} MOF — UMCM-9
:img-top: assets/renders/umcm-9.png
:img-alt: UMCM-9 metal-organic framework

Metal-organic framework · 809 atoms
:::

:::{grid-item-card} Periodic water
:img-top: assets/renders/water-box.png
:img-alt: Periodic box containing 27 water molecules

Centred cell · 27 molecules

+++
{download}`Figure recipe <assets/recipes/water-box.pqfigure.json>`
:::

:::{grid-item-card} Crystal — NaCl
:img-top: assets/renders/nacl-crystal.png
:img-alt: Sodium chloride crystal supercell

2 × 2 × 2 supercell · coordination polyhedra

+++
{download}`Figure recipe <assets/recipes/nacl.pqfigure.json>`
:::

:::{grid-item-card} COF — ACOF
:img-top: assets/renders/acof-framework.png
:img-alt: Triclinic ACOF covalent organic framework

Triclinic covalent organic framework
:::
::::

Gallery images were rendered with PQViewer. Crambin coordinates are from
[PDB 1CRN](https://www.rcsb.org/structure/1CRN). ACOF and UMCM-9 are PQAnalysis
examples.

```{toctree}
:hidden:
:maxdepth: 2

getting-started
viewer-guide
data-and-conventions
trajectory-analysis
figures-and-recipes
python-api
troubleshooting
```
