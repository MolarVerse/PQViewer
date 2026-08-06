# Data sources and periodic conventions

## Source types

The core installation opens:

| Source | Behavior |
| --- | --- |
| PQ `.xyz`, `.extxyz`, `.extended.xyz` | Indexed structure or trajectory |
| PQ `.in` | Resolves declared outputs relative to the input |
| Run directory | Opens one unambiguous run or declared restart chain |
| `path@start:stop:step` | Lazy view using Python slice rules |
| `.pqfigure.json`, `.pqv.json` | Reopens a source-validated figure recipe |

A directory with unrelated runs is rejected. Open the intended PQ input or
trajectory directly.

Install the `ase` extra to open ASE `Atoms`, indexed sequences of `Atoms`,
`.traj`, and file types detected by ASE:

```bash
python -m pip install 'molarverse-pqviewer[ase]'
```

ASE `.traj` files and indexed Python sequences retain indexed access. Other ASE
formats may require an initial metadata scan. Format support follows the
installed ASE version.

The browser file picker supports XYZ variants, ASE trajectory, CIF, PDB,
VASP/POSCAR/CONTCAR, CUBE, PQ inputs, and PQ companions. The CLI is the clearer
path for large or multi-file runs. One browser-open operation accepts up to
eight files, 2 GiB per file, and 4 GiB in total.

## PQ companions

PQViewer discovers a same-stem companion when exactly one candidate exists:

| Property | Suffixes |
| --- | --- |
| Forces | `.force`, `.frc`, `.forces` |
| Velocities | `.vel`, `.velocs`, `.velocity` |
| Charges | `.charge`, `.chrg`, `.charges` |
| Energy | `.en` |
| Info | `.info` |
| Restart | `.rst` |

`moldescriptor.dat` in the trajectory directory is also discovered. PQ input
files and `file_prefix` declarations take precedence. Explicit CLI options can
override discovered companions.

Companion arrays align by frame index and must match the trajectory's atom
order. The viewer reports partial companions rather than extending their last
value.

## Stable topology and frame identity

A dataset has one stable atom topology. A frame with a different atom count or
element order is rejected instead of silently remapping selections and bonds.

Each frame carries:

- source identity
- restart segment and local source index
- viewer frame index
- simulation step when present
- physical time and its unit when present

For in-memory ASE objects, source identity is stable only within the opened
dataset.

## Units

Positions and cells use ångström in the viewer contract. PQAnalysis supplies PQ
properties and declared metadata units. The ASE adapter exposes ASE positions in
ångström, forces in eV/Å, velocities in Å/fs, and charges in elementary charge.

The interface shows a unit only when the source declares or defines it. It does
not infer unknown scalar-property units.

## Centered periodic cells

PQ uses the centered fractional interval `[-0.5, 0.5)`. The displayed primary
cell therefore extends half a lattice vector on either side of its selected
origin, rather than from fractional `0` to `1`.

This convention applies to orthorhombic and triclinic cells. Wrapping and
minimum-image measurements operate in fractional coordinates, then transform
back to Cartesian coordinates.

The periodic display modes are non-destructive:

- **Atoms** wraps each atom independently into the displayed cell.
- **Molecules** wraps known connected molecules as whole units.
- **Unwrapped** follows continuous motion between frames.
- **Source coordinates**, available through search, shows stored positions.
- **Center cell** moves the displayed cell origin to PQ, the structure, or the
  selection.
- **Mirror** reflects the Cartesian display along a distance-preserving axis
  derived from `a`, `b`, or `c`.
- **Repeat** adds bounded neighboring images.

None of these operations rewrites the trajectory. A figure recipe records the
chosen display state.
