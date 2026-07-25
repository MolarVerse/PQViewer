# Python API

The Python API uses the same indexed dataset contract as the command line.

## Open a dataset

```python
from pqviewer import open_run_dataset

dataset = open_run_dataset(
    "trajectory.xyz",
    frame_slice=slice(None, None, 10),
)

manifest = dataset.manifest()
frame = dataset.get_frame(0)
unwrapped = dataset.get_frame(0, coordinates="unwrapped")
added_frames = dataset.refresh()
```

`manifest()` describes topology, properties, series, source provenance, and
frame count. `get_frame()` reads one requested frame. `refresh()` discovers
complete frames appended to a growing source.

Sidecars use the same names as the CLI:

```python
dataset = open_run_dataset(
    "trajectory.xyz",
    forces_path="trajectory.force",
    velocities_path="trajectory.vel",
    charges_path="trajectory.chrg",
)
```

## ASE objects

Install the `ase` extra, then pass an `Atoms` object or indexed sequence:

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

## Create an application

`create_app` returns the FastAPI application used by the CLI:

```python
from pqviewer import create_app, open_run_dataset

dataset = open_run_dataset("trajectory.xyz")
app = create_app(dataset=dataset)
```

Run the module containing `app` with Uvicorn when embedding the viewer in a
local Python workflow.

The public package currently exports:

- `FrameData`
- `FrameKey`
- `IndexedFrameSource`
- `PQTrajectoryDataset`
- `RunDataset`
- `create_app`
- `encode_frame`
- `open_run_dataset`

The project is pre-1.0. Treat the HTTP transport and frontend state as internal;
the documented Python names may still evolve with release notes.
