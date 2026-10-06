# Data sources and periodic conventions

## Source types

| Source | Behavior | Installation |
| --- | --- | --- |
| PQ `.xyz`, `.extxyz`, `.extended.xyz` | Indexed structure or trajectory | Core |
| PQ `.in` | Outputs resolved relative to the input | Core |
| Run directory | One unambiguous run or declared restart chain | Core |
| `path@start:stop:step` | Lazy view using zero-based Python slice rules | Core |
| `.pqfigure.json`, `.pqv.json` | Source-validated figure recipe | Core |
| ASE `Atoms`, indexed sequences, `.traj`, and detected formats | Optional file and Python adapter | `ase` extra |

A directory containing unrelated runs is rejected; open the intended input or
trajectory directly. ASE `.traj` and indexed Python sequences retain indexed
access. Other ASE formats may need an initial metadata scan. Format support
depends on the installed ASE version.

Install the adapter with `python -m pip install 'MolarVerse-PQViewer[ase]'`.

The browser picker accepts XYZ variants, ASE trajectory, CIF, PDB,
VASP/POSCAR/CONTCAR, CUBE, PQ inputs, and companions. Formats handled by ASE need
the extra. Each open operation accepts at most eight files, 2 GiB per file, and
4 GiB in total. Use the CLI for large or multi-file runs.

## Companion alignment

A same-stem PQ companion is discovered when exactly one candidate exists:

| Property | Suffixes |
| --- | --- |
| Forces | `.force`, `.frc`, `.forces` |
| Velocities | `.vel`, `.velocs`, `.velocity` |
| Charges | `.charge`, `.chrg`, `.charges` |
| Energy | `.en` |
| Info | `.info` |
| Restart | `.rst` |

`moldescriptor.dat` in the trajectory directory is also discovered. PQ input
paths and `file_prefix` declarations take precedence; explicit CLI options
override discovery.

Arrays align by frame index and atom order. A partial companion remains partial;
its last value is never extended to later frames.

## Topology and frame identity

Atom count and element order must stay constant within a dataset. Frames that
change either are rejected, preserving selection and bond identity.

| Identity field | Meaning |
| --- | --- |
| Source | File or restart segment |
| Local source index | Frame within that source |
| Viewer index | Frame within the opened dataset or slice |
| Step and time | Source values, with time units when declared |

Python and source indices are zero-based; timeline frame numbers start at one.
In-memory ASE identity lasts only within the opened dataset. Do not infer
physical time from frame index or playback rate.

## Units

Use Cartesian positions and lattice vectors in Å. PQ numeric values and
declared metadata are retained; declaring a unit does not perform a conversion.

Coordinates and cell vectors sent to the browser use 32-bit floats;
interactive measurements inherit that precision.

| Quantity | PQ source convention | ASE adapter |
| --- | --- | --- |
| Positions and cell | Expected in Å | Å |
| Force | PQ-format companions: kcal/(mol Å) | eV/Å |
| Velocity | PQ-format companions: Å/s | Å/fs |
| Charge | PQ-format companions: elementary charge, `e` | Elementary charge, `e` |
| Energy and other scalars | Source-declared unit | Energy/free energy in eV; other scalars as declared |
| Time | Source-declared unit | Source-declared unit |

Properties embedded in XYZ metadata use declared units; missing property units
remain unknown in the interface. Verify units before comparing sources, in
particular PQ and ASE force or velocity values.

## Centered periodic cells

PQViewer wraps enabled periodic axes into the half-open fractional interval
`[-0.5, 0.5)` about the selected cell origin. For row lattice vectors
`A = [a; b; c]`, Cartesian coordinates satisfy `r = o + f A`.

```{math}
f_i^{\mathrm{wrap}} = f_i - \left\lfloor f_i + \tfrac12 \right\rfloor
```

This applies to orthorhombic and triclinic cells. Non-periodic axes retain their
coordinates. The upper face maps to the lower face.

Interactive minimum-image measurements find the shortest Cartesian
displacement over enabled lattice translations. In a skewed cell, independently
centering fractional components alone does not necessarily give that shortest
displacement. **Displayed images** measures the replicas actually selected.

| Display mode | Effect |
| --- | --- |
| Atoms | Wrap each atom into the displayed cell |
| Molecules | Wrap known connected molecules as whole units |
| Unwrapped | Accumulate image shifts between consecutive frames |
| Source coordinates | Show stored positions; available through search |
| Center cell | Place the displayed origin at PQ, the structure, or the selection |
| Mirror | Reflect along a distance-preserving Cartesian axis derived from `a`, `b`, or `c` |
| Repeat | Add bounded neighboring images |

Display operations preserve source coordinates. Figure recipes record the
chosen display state.

## Partial cells and vacuum

ASE sources may be periodic along one or two axes. Each enabled axis requires
a nonzero lattice vector, and present vectors must be independent. Missing
non-periodic vectors are completed into a computational basis; completion does
not add physical periodicity or define a slab's vacuum thickness.

Without a finite cell, the viewer uses vacuum coordinates. Unwrapped image
tracking resets when either side of a frame transition is vacuum; continuity
is not carried across that transition. Unwrapping also requires sufficiently
frequent frames to resolve periodic crossings from consecutive displacements.

[Pair distribution](trajectory-analysis.md#pair-distribution-and-coordination)
requires all three periodic axes and a finite cell volume, even when a partial
cell is sufficient for viewing and measurements.
