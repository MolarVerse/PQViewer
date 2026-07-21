# PQViewer

PQViewer is a local molecular trajectory viewer built on PQAnalysis. It pairs
indexed trajectory access with a fast Three.js interface for playback,
inspection, forces, cells, bonds, and energy traces.
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

The viewer runs locally and opens in the default browser. Use `--no-open` for
remote or scripted use.

## Develop

Frontend development requires Node.js 20.19 or newer:

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
