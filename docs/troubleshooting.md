# Troubleshooting

## The browser did not open

Open `http://127.0.0.1:8765` manually. To suppress automatic opening:

```bash
pqviewer trajectory.xyz --no-open
```

Choose another port if 8765 is already in use:

```bash
pqviewer trajectory.xyz --port 8877
```

## A file needs ASE

Install the optional adapter:

```bash
python -m pip install 'MolarVerse-PQViewer[ase]'
```

PQViewer then uses the formats detected by the installed ASE version.

## A companion is missing

Automatic discovery requires one unambiguous same-stem candidate. Supply the
path explicitly:

```bash
pqviewer trajectory.xyz --forces other-name.force
```

Check that companion frame count and atom order match the trajectory.

## A run directory is ambiguous

Open the intended `.in` file or trajectory directly. PQViewer joins restart
segments only when their declared restart/start files form one chain.

## Molecules cannot be wrapped as whole units

Whole-molecule wrapping and residue selection need connectivity or semantic
residue data. Supply a restart, moldescriptor, or topology file. Atom wrapping
remains available without it.

## Pair analysis is unavailable

Pair distribution and coordination require:

- more than one frame
- a file-backed source
- a full periodic cell along `a`, `b`, and `c`

The analysis is bounded. Reduce selections or sampled frames when the setup
reports that it is too large.

## Headless rendering cannot find Chromium

```bash
python -m pip install 'MolarVerse-PQViewer[render]'
python -m playwright install chromium
```

Then rerun `pqviewer render`. Use `--timeout` for unusually slow graphics
initialization.

## A figure recipe no longer opens

Recipes validate the source path, slice, frame identity, and content. Restore
the original source, move the recipe with its relative data layout, or save a
new recipe from the changed trajectory.

Recipes saved from another machine may contain absolute paths that need the
same data location.

## Remote access

The default loopback address is intentional. PQViewer has no authentication or
TLS. Do not bind `--host 0.0.0.0` on an untrusted or publicly reachable network.

## Reporting a problem

Include the operating system, Python version, browser, input type, exact
command, and the shortest reproducible fixture. Do not attach confidential
simulation data to a public issue.
