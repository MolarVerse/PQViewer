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

The same command accepts a PQ input, a run directory, or a frame slice:

```bash
pqviewer path/to/run-01.in
pqviewer path/to/run-directory
pqviewer 'path/to/md.xyz@100:1000:10'
```

PQ inputs resolve their declared outputs relative to the input file. Prefix-only
runs automatically attach `.xyz`, `.force`, `.vel`, `.chrg`, `.en`, `.info`,
and `.rst` files that exist. A directory opens one unambiguous run; restart
segments are joined only when their declared restart files form a chain.

Try the included trajectory with `pqviewer examples/water.xyz`.
Use `pqviewer examples/periodic-boundary.extxyz` to inspect centered wrapping,
forces, step/time metadata, and minimum-image measurements.
Use `pqviewer examples/periodic-crossing.extxyz` to inspect continuous
unwrapped motion, or `pqviewer examples/acof-triclinic.xyz` for a triclinic
framework.
Run `pqviewer` without a path to open an empty workspace.

ASE support is optional:

```bash
python -m pip install 'pqanalysis-viewer[ase]'
pqviewer structure.cif
pqviewer optimization.traj
```

ASE `Atoms`, indexed trajectories, and supported files use the same transport:

```python
from pqviewer import open_run_dataset

dataset = open_run_dataset(atoms)
frame = dataset.get_frame(0)
```

PQ and ASE frames retain a stable source ID, segment index, local frame index,
step, time, and units. Slices are views over the indexed source; coordinates
and restart segments are not copied into memory.
Large indexed ASE trajectories skip an eager timeline scan; step and time stay
available on each loaded frame.

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
PQ input bundles can be opened together with their output files.
`View` opens the controls supported by the current data in one click:
representation, water, cell, force and velocity vectors, periodic wrapping, and
neighboring images. Ribbon appears when residue and backbone topology are
present. Periodic coordinates follow PQ's centered `−½…+½` convention.
Choose atom, whole-molecule, or continuous unwrapped coordinates. The cell can
stay at the PQ origin or center on the structure or selection. Cartesian mirror
controls preserve distances, while per-axis repeats stay within the renderer's
cell and atom limits. Source coordinates remain available through command
search.

Click an atom for a compact readout. Shift-click additional atoms to measure a
distance, angle, or ordered dihedral. On touch screens, tap atoms in order and
tap a selected atom again to remove it. Periodic measurements use the exact
minimum image by default; switch to displayed images when inspecting replicas.
`Plot` follows the measurement across the trajectory and exports CSV or SVG.
`Details` shows the selected atom's position and available per-atom values.

The trajectory bar appears only for multi-frame data. It provides first,
previous, play/pause, next, last, scrubbing, and the current frame number.
Playback options contain speed, stride, once, loop, and rock modes. Scalar
properties do not change the structural view or occupy the timeline.

Search every action with `Cmd/Ctrl+K` or `/`. Press `?` for the complete shortcut
sheet. `Space` plays or pauses, arrow keys step frames, `Home` and `End` jump to
the trajectory limits, `R` fits the structure, and `Escape` closes the open card.
Optional Vim navigation adds `h`/`l`, `H`/`L`, `gg`, `G`, `:`, and `Ctrl+[`.

`Figure` or `Cmd/Ctrl+Shift+S` immediately writes a publication PNG at
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
npx playwright install chromium
npm run test:e2e
```
