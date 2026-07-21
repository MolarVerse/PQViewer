# PQViewer

PQViewer is a local molecular trajectory viewer built on PQAnalysis. It pairs
indexed trajectory access with a fast Three.js interface for trajectories,
forces, periodic systems, solvent filtering, and structural inspection.
Periodic cells use PQ's centered `[-0.5, 0.5)` convention.

## Install

PQViewer requires Python 3.12 or newer. From a checkout:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install .
```

The web interface is bundled with the Python package, so Node.js is not needed
to install or run PQViewer.

## View a trajectory

```bash
pqviewer path/to/md.xyz
```

Try the included trajectory with `pqviewer examples/water.xyz`.
Run `pqviewer` without a path to open an empty workspace.

Add a PQ energy file when available:

```bash
pqviewer path/to/md.xyz --energy path/to/md.en
```

Same-stem PQ companions are detected automatically; override them explicitly:

```bash
pqviewer path/to/md.xyz \
  --forces path/to/md.force \
  --velocities path/to/md.vel \
  --charges path/to/md.chrg
```

Add semantic residue and bond data when available:

```bash
pqviewer path/to/md.xyz \
  --moldescriptor path/to/moldescriptor \
  --topology path/to/topology
```

Files can also be opened together from the interface or dropped on the canvas.
The Scene control groups representations, water and hydrogen filters, forces,
and periodic images. Cell image ranges use integer lattice offsets, so a unit
cell can be moved or expanded along each periodic axis. Ribbon view is enabled
only when residue and backbone topology are present. Large force fields are
evenly sampled, with displayed and total vector counts reported under Data.

Playback defaults to every frame. Realtime playback, wrapping, geometry scale,
quality, and appearance are available under Customize.
Dense or replicated scenes stay responsive by switching atom instances above
80,000 to points and bond segments above 80,000 to lines, including when High
quality is selected.

For publication images, choose More → Render image or press `Cmd/Ctrl+Shift+S`.
Export a preset or custom PNG with the canvas or a transparent background. Fit
keeps the current orientation and adds balanced spacing. Exports are limited to
24 megapixels for reliable browser rendering.

The viewer runs locally and opens in the default browser. Use `--no-open` for
remote or scripted use.

## Develop

Frontend development requires Node.js 20.19+ on the 20.x line, or 22.12+:

```bash
python -m pip install -e ".[dev]"
cd frontend
npm ci
npm run build
cd ..
```

Run the API and Vite development server in separate terminals:

```bash
pqviewer path/to/md.xyz --no-open
cd frontend && npm run dev
```

Run the checks with:

```bash
python -m pytest
cd frontend
npm test
npm run build
```
