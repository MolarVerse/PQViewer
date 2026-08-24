# Viewer guide

The interface is one continuous scientific workspace. The structure stays on
the canvas while **View**, **Edit**, **Analyze**, and **Export** expose one task
at a time. On narrow screens, **Tools** opens the same View/Edit/Analyze
inspector as a bottom sheet; its arrow expands the sheet to full height.

## Canvas

- Drag to rotate.
- Secondary-drag or middle-drag to pan.
- Scroll or pinch to zoom.
- Click an atom to select it.
- Shift-click to extend or reduce the selection.
- Shift-drag empty space for box selection.
- Click empty space to clear the selection.

The small canvas controls fit the structure and select perspective, XY, XZ, or
YZ views. Camera orientation and selection stay stable while frames change.

## Edit

Choose **Edit** or press `E` for source-data changes. **Cell + structure**
shows the formula, atom and frame counts, and boundary conditions. The cell
editor accepts either lengths and angles or the full 3 × 3 lattice vectors.
Each periodic axis can be enabled separately. By default, changing the cell
keeps Cartesian atom positions fixed; enable **Keep fractional positions**
when atoms should scale with the lattice.

Molecules without a source cell receive a centered orthorhombic suggestion
based on their coordinate extent. Applying it creates a cell; nothing is added
automatically.

Clicking an atom opens its read-only scientific details in **Analyze**. Choose
**Edit atom** there, or choose **Selected atom** while Edit is open, to change
element identity and Cartesian coordinates. Element changes apply to the whole
structure, while coordinates apply to the displayed frame. Edits are local,
reversible, and used by figure export. **Download current frame** writes the
edited structure as EXTXYZ, including lattice and periodic-axis information.

## Analyze

Analyze is always available. With no selection it explains the selection
gestures. One selected atom shows its identity, position, charge, force, and
velocity values without exposing accidental edits. Ordered selections of two,
three, or four atoms show a distance, angle, or dihedral. Larger selections
show their formula, centroid, extent, and unique-atom count.

The selection bar exposes actions that apply to the current selection:

- **Select** expands the selection to an element, molecule, residue, connected
  component, or atoms within a distance.
- **Plot** follows a distance, angle, or dihedral across the trajectory.
- **Pin** keeps a measurement for recall or comparison.
- **Track** shows the selected atoms' recent paths.
- **Analyze** opens pair-distribution setup for suitable periodic data.
- **Details** inspects a single atom.
- **Summary** reports formula, center, extent, and atom count for larger
  selections.

Periodic measurements use the exact minimum image by default. Switch to
displayed images when measuring a chosen replica.

Saved selections and pinned measurements last for the current workspace and
dataset. Reloading the browser clears them.

## View

Choose **View** or press `V` to open the controls supported by the current
source.

Representations are explicit: ball-and-stick, spacefill, licorice, lines,
ribbon, coordination polyhedra, and surface. Atom color, hydrogen visibility,
and atom and bond size follow in the same inspector, then on/off layers such as
bonds, water, the cell, forces, and velocities. Periodic wrap, centering, and
repeats stay in a collapsed **Periodic cell** section when a cell is present.
Light and dark appearance and interactive quality sit at the end, because they
change the viewer chrome rather than the scientific display. PQViewer chooses a
sensible initial display for the loaded data, but every representation and
layer remains directly controllable; the inspector does not require a
scientific-system preset.

Coordination geometry follows the visible bonding topology. Planar ligand
shells are shown as polygons; non-planar shells are shown as polyhedra. When
bonds are inferred, PQViewer uses the nearest distance shell so longer contacts
do not inflate coordination. If several metal sites are available, transition
metal coordination is preferred; this keeps perovskites focused on their
octahedral network. Polyhedra that protrude outside a displayed single cell are
omitted, and dense structures show a deterministic subset.

A single visible unit cell does not draw minimum-image bonds through its
boundary. Repeated-cell views retain bonds between neighboring displayed cells.

**Overlays**

- Show or hide water
- Show or hide the periodic cell
- Display force and velocity vectors with adjustable scale

**Periodic**

- Atom coordinates: wrap each atom into the displayed cell
- Molecule coordinates: keep known molecules whole while wrapping
- Unwrapped coordinates: follow continuous motion across frames
- Center the displayed cell at the PQ origin, structure, or selection
- Mirror the display along `a`, `b`, or `c`
- Repeat periodic images along each available axis

These controls change the display only. They do not rewrite source coordinates.
Use command search for **Source coordinates** when the stored coordinates need
to be shown without display wrapping.

The interactive view uses the locally bundled 3Dmol renderer. If it cannot
initialize, PQViewer keeps the established Three renderer available as a
fallback.

## Export

**Export** opens one figure inspector for size, DPI, PNG or TIFF, white or
transparent background, projection, labels, legend, scale bar, and reproducible
figure recipes. The interactive 3Dmol canvas is not treated as publication
output: figures use the independent high-quality renderer. Press
`Cmd/Ctrl+Shift+S` for a quick 2400 × 1800 PNG with publication defaults.

## Trajectory

The timeline appears for multi-frame data. It provides first, previous,
play/pause, next, last, scrubbing, and the current frame. Its menu contains:

- playback rate, stride, and once, loop, or rock mode
- frame bookmarks
- one reference frame
- supplied scalar-property plots
- displacement vectors after a reference frame is set
- pair-distribution and coordination analysis when supported

Property and measurement plot cursors follow the displayed frame. Selecting a
point in those plots navigates back to its frame. Pair-distribution and
coordination plots aggregate frames and are not linked to one current frame.

Start selected-atom trails with **Track** in the selection bar or command search.
Trails show the current position and up to 50 previous frames. The
reference-frame menu controls displacement vectors.

Selections, pins, bookmarks, and references belong to the current workspace and
reset when a new dataset is opened. Up to eight measurements, twelve bookmarks,
and sixteen atom-image selections can be tracked at once.

## Search and keyboard

The central **Search** control finds atoms, settings, and commands. Press `⌘K`
on macOS, `Ctrl+K` on Linux and Windows, or `/` on any platform. Type to filter,
use `↑` and `↓` to move through results, and press `Enter` to open the selected
setting or run the selected command. Setting results show their path, such as
**View › Layers › Bonds** or **Edit › Cell › Vectors**, then open collapsed
sections, scroll the setting into view, and highlight it briefly.

Natural scientific terms are indexed. Queries such as `bond across cell`,
`atom color`, `edit lattice vectors`, `distance`, `dark mode`, and
`transparent image` lead to the relevant control. Search also accepts commands
such as `select within 3 Å of selection`.

| Keys | Action |
| --- | --- |
| `←` / `→` | Previous or next frame |
| `Shift` + `←` / `→` | Move ten frames |
| `Home` / `End` | First or last frame |
| `Space` | Play or pause |
| `M` | Bookmark the current frame |
| `R` | Fit the structure |
| `1` / `2` / `3` / `4` | Perspective / XY / XZ / YZ |
| `↑` / `↓`, `Enter` | Browse atoms and toggle selection |
| `E` / `V` | Edit / View tools |
| `D` | Light or dark appearance |
| `B` | Toggle lines and ball-and-stick |
| `C` / `F` / `W` | Toggle cell / forces / water |
| `Cmd/Ctrl+O` | Open files |
| `Cmd/Ctrl+Shift+S` | Export a figure |
| `?` | Shortcut sheet |
| `Escape` | Close the active surface or clear selection |

Optional Vim navigation is enabled in the shortcut sheet:

| Keys | Action |
| --- | --- |
| `h` / `l` | Previous / next frame |
| `H` / `L` | Back / forward ten frames |
| `gg` / `G` | First / last frame |
| `:` | Search atoms, settings, and commands |
| `Ctrl+[` | Close the active surface |

Pointer controls remain available when Vim navigation is enabled.
