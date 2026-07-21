# PQViewer

PQViewer is a local molecular trajectory viewer built on PQAnalysis. It pairs
indexed trajectory access with a fast Three.js interface for playback,
inspection, forces, cells, bonds, and energy traces.

## Install

PQViewer requires Python 3.12 and Node.js 20.19 or newer.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"
cd frontend
npm ci
npm run build
cd ..
```

## View a trajectory

```bash
pqviewer path/to/md.xyz
```

Try the included trajectory with `pqviewer examples/water.xyz`.

Add a PQ energy file when available:

```bash
pqviewer path/to/md.xyz --energy path/to/md.en
```

The viewer runs locally and opens in the default browser. Use `--no-open` for
remote or scripted use.

## Develop

Run the API and Vite development server in separate terminals:

```bash
pqviewer path/to/md.xyz --no-open
cd frontend && npm run dev
```

Run the checks with:

```bash
python -m pytest
cd frontend && npm run build
```
