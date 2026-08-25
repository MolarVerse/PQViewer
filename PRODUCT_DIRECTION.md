# Product direction

PQViewer is a direct molecular structure and trajectory viewer for the PQ
ecosystem. It should preserve the short path from a file or Python object to a
useful view that makes `ase gui` effective, while improving periodic behavior,
long-trajectory access, interaction, and scientific output.

The primary workflow is:

```text
pqviewer trajectory.xyz
  → inspect
  → navigate
  → select or measure
  → adjust the periodic display
  → export a figure
```

PQViewer is not a dashboard, simulation IDE, file manager, or notebook
replacement.

## Product principles

### Direct

One command opens useful data. Common controls stay on the canvas, contextual
actions appear with a selection or trajectory, and major viewer actions remain
searchable.

### Scientifically explicit

Units, frame identity, periodic measurement mode, coordinate mode, and analysis
populations are visible. Missing capabilities are not simulated.

### Non-destructive

Wrapping, unwrapping, cell centering, mirroring, repeats, representations, and
camera changes affect the view only. Source coordinates remain unchanged.

### Local and reproducible

The viewer runs locally. Figure recipes retain source, frame, camera, display,
selection, annotation, and output state and validate the source before reuse.

### Calm

The structure owns the screen. The default interface is light, high-contrast,
and compact, with one contextual surface at a time. Keyboard and Vim paths
accelerate the pointer interface rather than replacing it.

## Architecture direction

The intended ecosystem boundary is:

PQAnalysis:

- indexed scientific data access
- source and frame identity
- units and property alignment
- canonical centered-cell operations
- scientific calculations and typed results

PQViewer owns:

- local application server and transport
- molecular rendering and interaction
- representations and non-destructive display transforms
- plots and analysis presentation
- publication figures and view recipes

PQEnalyzer remains a separate terminal client. PQViewer does not depend on it.

Today, PQViewer still implements the adapter-level `RunDataset` and `FrameKey`,
interactive measurements, selection geometry, wrapping, and unwrapping.
PQAnalysis currently supplies PQ readers, cell primitives, topology, and pair
distribution calculations. Shared contracts should move upstream only when
they are stable enough for the wider ecosystem.

## Current release scope

The public beta already covers:

- PQ trajectories, inputs, run directories, and declared restart chains
- optional ASE files, `Atoms`, and indexed trajectories
- Jupyter `view()` embedding and a static web demo
- lazy PQ frame access and bounded frontend prefetching
- PQ-centered orthorhombic and triclinic cells
- atom, molecule, unwrapped, mirrored, centered, and repeated periodic views
- local atom and cell edits with EXTXYZ download
- direct and scoped selection, measurements, saved selections, and comparisons
- trajectory playback, bookmarks, reference displacement, and atom trails
- scalar, measurement, pair-distribution, and coordination plots
- forces, velocities, charges, water display, and topology-aware ribbons
- command search, broad keyboard access, and optional Vim navigation
- publication raster figures, vector plot output, and source-validated recipes

Packaging (`MolarVerse-PQViewer` on PyPI) and notebook embedding exist. Do not
rebuild them. Finish honesty, the PQ run loop, and citable exports.

## Next steps

Work in this order. Do not start later items to look busy.

### 1. Honest disabled actions

Every control that cannot run should say which data it needs: ribbon, polyhedra,
unwrapped coordinates, pair distribution, coordination, tracking, recipes, and
missing sidecars. Missing capabilities stay hidden or disabled. They are never
faked.

### 2. The PQ run as the default path

`pqviewer path/to/run` should be the usual step after a job. Explain restart
chains, incomplete companions, and growing files in the interface. Keep
`refresh()` bounded. Do not add a file manager.

### 3. Exports a paper can reuse

Measurement and pair-analysis CSV should record units, frame identity, periodic
mode, and analysis populations. Figure recipes already validate the source;
keep them the reproducibility contract.

### 4. Examples people can open

Ship small redistributable liquid, crystal, MOF, and protein fixtures in
`examples/`, including the sources already used in the docs. Provenance stays
in `examples/README.md`.

### 5. After 1.0

Harden Jupyter for remote kernels (loopback and port forwarding). Move stable
`FrameKey`, centered-cell, and pair-result contracts upstream into PQAnalysis
only after they stop changing.

### Not now

Do not start extension APIs, a second interactive engine, PQEnalyzer embedding,
or VMD/OVITO plugin parity. Those wait until the core viewer has release
experience.

## Quality gates

Every release needs:

- executable centered-cell and triclinic reference comparisons
- unit and frame-alignment tests
- Python, frontend, browser, render, and package-install checks
- desktop and narrow-width visual inspection
- stress coverage for large atoms, long trajectories, periodic images, rapid
  scrubbing, incomplete companions, and high-resolution figures
- no stale-frame labels, silent export failure, or unbounded trajectory memory

## Not in scope

- simulation setup or execution
- cluster and job management
- calculator setup (ASE calculator results may be read; never trigger `calculate`)
- growing Edit into molecule building
- a permanent energy dashboard
- embedding the PQEnalyzer interface
- duplicating PQAnalysis calculations in the frontend
- a second interactive rendering engine (`?renderer=three` is not a product)
- broad plugin parity with VMD, OVITO, or ChimeraX
- extension APIs before 1.0
