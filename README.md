# <img src="docs/_static/pq-logo.png" alt="PQ logo" width="48"> PQViewer

Inspect molecular structures, trajectories, and periodic geometry in a desktop browser.

![SrTiO3 coordination polyhedra with the View inspector open](docs/assets/screenshots/viewer-workspace.png)

## Start

Use Python 3.12 or newer and a browser with WebGL 2.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install MolarVerse-PQViewer
pqviewer trajectory.xyz
```

Replace the path with your file, or try the
[three-frame water example](https://molarverse.github.io/PQViewer/getting-started.html).

## Controls

| Control | Use |
| --- | --- |
| **View** | Representations, layers, and periodic display |
| **Analyze** | Atom properties, measurements, and trajectory plots |
| **Export** | Figures and source-validated recipes |

Follow the [visual guide](https://molarverse.github.io/PQViewer/viewer-guide.html),
or [open the web demo](https://molarverse.github.io/PQViewer/viewer/).
For cluster and home VPN use, follow [Remote access](https://molarverse.github.io/PQViewer/remote-access.html).

PQViewer is in public beta; file and Python interfaces may change before 1.0.
[Release notes](CHANGELOG.md) · [Citation](CITATION.cff) · [Contributing](CONTRIBUTING.md) ·
[MIT License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
