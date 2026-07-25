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

The first public release covers:

- PQ trajectories, inputs, run directories, and declared restart chains
- optional ASE files, `Atoms`, and indexed trajectories
- lazy PQ frame access and bounded frontend prefetching
- PQ-centered orthorhombic and triclinic cells
- atom, molecule, unwrapped, mirrored, centered, and repeated periodic views
- direct and scoped selection, measurements, saved selections, and comparisons
- trajectory playback, bookmarks, reference displacement, and atom trails
- scalar, measurement, pair-distribution, and coordination plots
- forces, velocities, charges, water display, and topology-aware ribbons
- command search, broad keyboard access, and optional Vim navigation
- publication raster figures, vector plot output, and source-validated recipes

## Next priorities

1. Publish a documented, installable release with stable packaging and examples.
2. Make unsupported actions explain their data requirements in the interface.
3. Improve exported scientific metadata for measurement and pair-analysis CSV.
4. Expand redistributable examples for liquids, crystals, MOFs, and proteins.
5. Add notebook embedding around the same dataset and renderer contracts.
6. Define extension contracts for representations and PQAnalysis results after
   the core API has release experience.

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
- coordinate editing or calculator setup
- a permanent energy dashboard
- embedding the PQEnalyzer interface
- duplicating PQAnalysis calculations in the frontend
- multiple interactive rendering engines without a clear scientific benefit
- broad plugin parity with VMD, OVITO, or ChimeraX
