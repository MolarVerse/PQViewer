# Jupyter

PQViewer can display the real local application in a Jupyter output cell. It is
not a screenshot or a reduced notebook renderer: the iframe retains 3Dmol.js,
structure and cell editing, representations, selection, command search,
trajectories, and figure export.

## Install

From a checkout:

```bash
python -m pip install -e '.[jupyter,ase]'
```

The `ase` extra is only required for ASE objects and formats handled by ASE.

## Display a file

```python
from pqviewer import view

viewer = view("trajectory.xyz", height=620)
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

`close` is safe to call more than once. A context manager is also available
for code that performs checks without retaining the cell:

```python
with view("trajectory.xyz") as viewer:
    print(viewer.url)
```

Local kernels work directly. With a remote Jupyter kernel, the browser also
needs access to the selected loopback port through the notebook environment or
an explicit port forward.

The complete workflow is in the
[executable example notebook](../examples/pqviewer-notebook.ipynb).
