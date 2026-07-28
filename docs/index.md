# PQViewer

PQViewer is a local molecular structure and trajectory viewer built on
[PQAnalysis](https://github.com/MolarVerse/PQAnalysis). It combines indexed
trajectory access, PQ-centred periodic cells, direct measurements, and
reproducible publication figures in a modern browser interface.

[Try the interactive viewer](https://molarverse.github.io/PQViewer/viewer/) · [Get started](getting-started.md) ·
[Jupyter](jupyter.md) · [Viewer guide](viewer-guide.md) ·
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

## Try it in the browser

<div class="pq-demo-shell">
  <div class="pq-demo-heading">
    <div>
      <strong>Interactive SrTiO3 perovskite</strong>
      <span>Drag to rotate. Use Search for Polyhedra.</span>
    </div>
    <a href="viewer/">Open full screen</a>
  </div>
  <iframe
    src="viewer/"
    title="Interactive PQViewer perovskite demo"
    loading="lazy"
    allowfullscreen
  ></iframe>
</div>

The web demo is a read-only build of the same interface. Install PQViewer for
local files, trajectory streaming, and PQAnalysis calculations. See
[how the web demo differs](web-demo.md).

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

:::{grid-item-card} Interactive web demo
:link: web-demo
:link-type: doc

The GitHub Pages viewer, its limits, and deployment path.
:::

:::{grid-item-card} Jupyter
:link: jupyter
:link-type: doc

Display the real local viewer in a notebook cell.
:::

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

:::{grid-item-card} Crystal — SrTiO3
:img-top: assets/renders/strontium-titanate.png
:img-alt: Strontium titanate perovskite with complete titanium oxygen octahedra

2 × 2 × 2 perovskite · contained TiO6 octahedra

+++
{download}`Figure recipe <assets/recipes/strontium-titanate.pqfigure.json>`
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
web-demo
jupyter
viewer-guide
data-and-conventions
trajectory-analysis
figures-and-recipes
python-api
troubleshooting
```
