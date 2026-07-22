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
`Display` contains only the current representation and the controls supported by
the data: Water, Cell, and Forces. Ribbon appears when residue and backbone
topology are present. Periodic coordinates follow PQ's centered `−½…+½`
convention and structures are wrapped automatically. Click an atom to see its
identity, position, and available per-atom values.

The compact timeline keeps every frame and provides previous, play/pause, next,
scrubbing, and the current frame number. `Space` plays or pauses, arrow keys step
frames, `R` fits the structure, and `Escape` closes the open card.

`Export` or `Cmd/Ctrl+Shift+S` immediately writes a publication PNG at
2400 × 1800 px. The export uses the current orientation with a fitted
orthographic camera, white background, complete periodic boundary bonds,
adaptive supersampling, restrained ambient occlusion, and explicit sRGB output.
Dense scenes stay responsive by switching large atom and bond sets to lighter
rendering paths.

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
