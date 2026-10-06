# Getting started

## Install

Use Python 3.12 or newer and a desktop browser with WebGL 2:

```bash
python -m pip install MolarVerse-PQViewer
```

The Python package includes the interface; Node.js is needed only for frontend
development. The installed command and import package are both `pqviewer`.

| Optional workflow | Install | Guide |
| --- | --- | --- |
| ASE formats or Python `Atoms` | `python -m pip install 'MolarVerse-PQViewer[ase]'` | [Data sources](data-and-conventions.md) |
| Jupyter output cell | `python -m pip install 'MolarVerse-PQViewer[jupyter]'` | [Jupyter](jupyter.md) |
| Headless figure rendering | `python -m pip install 'MolarVerse-PQViewer[render]'`, then `python -m playwright install chromium` | [Figures and recipes](figures-and-recipes.md) |

The release browser and rendering checks use Chromium on Linux. Other current
WebGL 2 browsers are outside that release coverage.

## Open a trajectory

```bash
pqviewer trajectory.xyz
```

PQViewer starts at `http://127.0.0.1:8765` and opens the default browser.
Replace the path with your trajectory. To try the repository's synthetic
three-frame water fixture without a checkout:

```bash
curl -fsSLo water.xyz https://raw.githubusercontent.com/MolarVerse/PQViewer/main/examples/water.xyz
pqviewer water.xyz
```

Use `--no-open` to open the browser yourself. With no path, `pqviewer` opens an
empty workspace for **Open** or drag-and-drop.

| Source | Command |
| --- | --- |
| Trajectory | `pqviewer trajectory.xyz` |
| PQ input | `pqviewer simulation.in` |
| One run or declared restart chain | `pqviewer path/to/run-directory` |
| Frames 100–999, every tenth frame | `pqviewer 'trajectory.xyz@100:1000:10'` |

Slices use zero-based Python `start:stop:step` rules; the stop is exclusive.
Quote a slice in the shell.

For a server or compute node, use `--no-open` and an SSH tunnel. Connect to
your institutional VPN first when working from home. See
[Remote access](remote-access.md) for commands, jump hosts, and data flow.

## Attach companion data

Unambiguous same-stem PQ companions are discovered automatically. Supply other
paths explicitly:

```bash
pqviewer trajectory.xyz \
  --forces trajectory.force \
  --velocities trajectory.vel \
  --charges trajectory.chrg
```

For molecule, residue, and bond information:

```bash
pqviewer trajectory.xyz \
  --moldescriptor moldescriptor.dat \
  --topology topology
```

For scalar trajectory properties:

```bash
pqviewer trajectory.xyz \
  --energy trajectory.en \
  --info trajectory.info
```

`--info` requires `--energy`. Companion arrays must share the trajectory's
frame order and atom order; see [alignment and units](data-and-conventions.md).

## Inspect and measure

1. Drag to rotate, secondary-drag or middle-drag to pan, and scroll to zoom.
2. Click an atom, then Shift-click others in measurement order. Two, three, or
   four atoms give a distance, angle, or dihedral.
3. Use the timeline to change frames. **Plot** traces a selected measurement.
4. Use **View** for representations and periodic display; **Edit** changes the
   current structure locally.
5. Choose **Export** to save a figure. Press `?` for shortcuts or
   `Cmd/Ctrl+K` to find a command.

Continue with [periodic conventions](data-and-conventions.md),
[viewer controls](viewer-guide.md), and [trajectory analysis](trajectory-analysis.md).
