# Jupyter

Embed PQViewer in a Jupyter output cell.

## Install

```bash
python -m pip install 'MolarVerse-PQViewer[jupyter]'
```

## Display a file

Use `water.xyz` from [Getting started](getting-started.md#open-a-trajectory),
or replace the path with your trajectory:

```python
from pqviewer import view

viewer = view("water.xyz", height=620)
viewer
```

`view` chooses an available `127.0.0.1` port and starts PQViewer in a daemon
thread. The returned `NotebookViewer` exposes its `url` and renders as an
iframe.

Companion files use the same names as `create_app`:

```python
viewer = view(
    "trajectory.xyz",
    forces_path="trajectory.force",
    velocities_path="trajectory.vel",
    topology_path="topology",
    height=680,
)
viewer
```

## Display an ASE object

Add the optional adapter:

```bash
python -m pip install 'MolarVerse-PQViewer[ase]'
```

```python
from ase.build import molecule
from pqviewer import view

viewer = view(molecule("C60"), height=620)
viewer
```

## Stop the server

```python
viewer.close()
```

`close` is safe to call more than once. For a bounded server lifetime:

```python
with view("water.xyz") as viewer:
    print(viewer.url)
```

Local kernels work directly. With a remote Jupyter kernel, the browser also
needs access to the selected loopback port through the notebook environment or
an explicit port forward. The iframe does not set up this route automatically.
For a separate desktop-browser workflow, use the
[CLI SSH forwarding guide](remote-access.md).

The complete workflow is in the
[executable example notebook](../examples/pqviewer-notebook.ipynb).
