# Getting started

## Requirements

- Python 3.12 or newer
- A current desktop browser with WebGL 2
- Node.js only when changing the frontend

The automated browser and render release suite uses Chromium on Linux. Other
current WebGL 2 browsers are intended to work but are not yet part of the
release suite.

## Install

```bash
python -m pip install molarverse-pqviewer
```

PQViewer includes its compiled interface in the Python package.
The distribution is named `molarverse-pqviewer`; the import package and command
remain `pqviewer`.

Optional ASE file and object support:

```bash
python -m pip install 'molarverse-pqviewer[ase]'
```

Optional Jupyter display support:

```bash
python -m pip install 'molarverse-pqviewer[jupyter,ase]'
```

Optional headless figure rendering:

```bash
python -m pip install 'molarverse-pqviewer[render]'
python -m playwright install chromium
```

## Open data

Open an empty workspace, then use **Open** or drop a structure onto the canvas:

```bash
pqviewer
```

PQViewer starts a local server at `http://127.0.0.1:8765` and opens the default
browser. Use `--no-open` when opening the browser yourself:

```bash
pqviewer examples/water.xyz --no-open
```

The command accepts four main source forms:

```bash
pqviewer trajectory.xyz
pqviewer simulation.in
pqviewer path/to/run-directory
pqviewer 'trajectory.xyz@100:1000:10'
```

The slice uses Python's `start:stop:step` rules. Quote it in the shell to avoid
special-character handling.

From a source checkout, `pqviewer examples/water.xyz` opens the included water
trajectory.

## Add companion data

Same-stem PQ companions are found automatically. They can also be supplied
explicitly:

```bash
pqviewer trajectory.xyz \
  --forces trajectory.force \
  --velocities trajectory.vel \
  --charges trajectory.chrg
```

Semantic molecule, residue, and bond information can be added when available:

```bash
pqviewer trajectory.xyz \
  --moldescriptor moldescriptor.dat \
  --topology topology
```

Energy and info files can supply scalar trajectory properties:

```bash
pqviewer trajectory.xyz \
  --energy trajectory.en \
  --info trajectory.info
```

`--info` requires `--energy`.

## First inspection

1. Drag to rotate, secondary-drag or middle-drag to pan, and scroll to zoom.
2. Click the first atom, then Shift-click further atoms in measurement order.
3. Use **View** for representations, vectors, water, appearance, and periodic display.
4. Use **Edit** for atom coordinates, identity, and cell data.
5. Use **Analyze** for atom properties, measurements, and periodic analysis.
6. Use the timeline for multi-frame data.
7. Press `Cmd/Ctrl+K` or `/` to search atoms, settings, and commands.
8. Press `?` or choose **Help** for the shortcut sheet.
9. Choose **Export** for a publication-ready figure of the current view.

Continue with the [viewer guide](viewer-guide.md) and
[data conventions](data-and-conventions.md). For notebook workflows, continue
with the [Jupyter guide](jupyter.md).
