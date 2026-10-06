# Python API

The Python API opens the same indexed datasets as the CLI. File examples use
`water.xyz` from [Getting started](getting-started.md#open-a-trajectory);
replace it with your own source.

## Read indexed frames

```python
from pqviewer import open_run_dataset

dataset = open_run_dataset("water.xyz")
manifest = dataset.manifest()
frame = dataset.get_frame(0)

print(dataset.frame_count)
print(frame.positions.shape, frame.units["positions"])
print(frame.frame_key)
```

| API | Result |
| --- | --- |
| `manifest()` | Topology, properties, scalar series, provenance, and frame count |
| `get_frame(index)` | One `FrameData` with Cartesian arrays and a `FrameKey` |
| `get_frame(index, coordinates="unwrapped")` | Source arrays plus `unwrapped_positions` and image shifts |
| `refresh()` | Number of newly discovered complete frames in a growing source |

Frame indices are zero-based. `frame.positions` has shape `(atoms, 3)`;
`frame.cell` has row lattice vectors and shape `(3, 3)`. Inspect `frame.pbc`
and `frame.units` before calculations. Low-rank ASE cells also expose a
completed `periodic_cell` basis for periodic calculations.

Request motion coordinates explicitly:

```python
motion = dataset.get_frame(1, coordinates="unwrapped")
positions = motion.unwrapped_positions
```

`motion.positions` still contains the source coordinates. Unwrapping follows
the [periodic and vacuum conventions](data-and-conventions.md#partial-cells-and-vacuum).

For a sliced dataset:

```python
dataset = open_run_dataset("water.xyz", frame_slice=slice(None, None, 2))
```

A sliced dataset's frame index refers to the slice; its `FrameKey` preserves
the source index.

## Attach companions

```python
dataset = open_run_dataset(
    "trajectory.xyz",
    forces_path="trajectory.force",
    velocities_path="trajectory.vel",
    charges_path="trajectory.chrg",
)
```

Replace these paths with aligned files; see
[companion alignment and units](data-and-conventions.md#companion-alignment).

## Open an ASE object

Install `MolarVerse-PQViewer[ase]`, then pass an `Atoms` object or an indexed
sequence:

```python
from ase import Atoms
from pqviewer import open_run_dataset

atoms = Atoms(symbols=["O", "H", "H"], positions=[
    [0.0, 0.0, 0.0],
    [0.7586, 0.0, 0.5043],
    [-0.7586, 0.0, 0.5043],
])
dataset = open_run_dataset(atoms)
frame = dataset.get_frame(0)
```

ASE positions are in Å. Source calculator results are read when available;
opening the dataset does not run a calculator.

## Serve an application

Save this as `viewer_app.py` beside your trajectory:

```python
from pqviewer import create_app, open_run_dataset

dataset = open_run_dataset("water.xyz")
app = create_app(dataset=dataset)
```

Run from that directory:

```bash
python -m uvicorn viewer_app:app --host 127.0.0.1 --port 8765
```

Open `http://127.0.0.1:8765`. `create_app` returns the FastAPI application used
by the CLI. For notebook embedding and server lifetime, use
[`view` and `NotebookViewer`](jupyter.md).

The file and Python interfaces may evolve before 1.0; consult the release notes
when upgrading. HTTP transport and frontend state are internal interfaces.
