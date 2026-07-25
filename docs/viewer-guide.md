# Viewer guide

The interface keeps the structure on the canvas and shows controls only when
the loaded data can use them.

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

## Selection

One selected atom shows its position in the selection bar. Choose **Details**
to inspect available charge, force, and velocity values. Ordered selections of
two, three, or four atoms show a distance, angle, or dihedral.

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

## View controls

Choose **View** once to open the display controls supported by the current
source.

**Representation**

- Ball + stick
- Spacefill
- Lines
- Ribbon when residue and backbone topology are present

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

Press `Cmd/Ctrl+K` or `/` to search the available commands. Search omits actions
that the current source cannot perform. It also accepts commands such as
`select within 3 Å of selection`.

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
| `V` | View controls |
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
| `:` | Search commands |
| `Ctrl+[` | Close the active surface |

Pointer controls remain available when Vim navigation is enabled.
