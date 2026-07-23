# PQViewer: modern ASE GUI plan

## Product decision

PQViewer should be a modern successor to `ase gui` and
`ase.visualize.view()` for the PQ ecosystem.

The primary workflow stays direct:

```text
pqviewer trajectory.xyz
  -> inspect
  -> navigate
  -> select or measure
  -> adjust periodic display
  -> export a figure
```

It is a viewer, not a dashboard, simulation IDE, file manager, or replacement
for notebooks. PQAnalysis supplies scientific data and calculations behind the
interface. PQEnalyzer remains a separate terminal client.

## What ASE gets right

ASE's strength is not its widget design. It is the small distance between an
`Atoms` object or file and a useful view.

PQViewer should preserve:

- one-command opening from a terminal
- support for structures, trajectories, multiple files, and frame slices
- a stable camera while frames change
- direct atom selection and automatic geometric measurements
- unit-cell, bond, label, force, and velocity display
- quick camera alignment and fit
- trajectory playback with frame stepping
- plots for trajectory properties and selected measurements
- saving the current frame or a frame range
- useful keyboard access without project setup

## What not to copy from ASE

ASE separates Movie, Graphs, Colors, Repeat, Settings, and Render into different
windows. Several operations modify the loaded coordinates, plots are not linked
to playback, all frames are normally loaded eagerly, and rendered movies must be
assembled outside the application.

PQViewer should instead provide:

- one integrated trajectory bar
- non-destructive display transforms
- on-demand plots linked to frames and selections
- bounded trajectory loading and prefetching
- stable topology unless reactive bonding is requested
- native PQ-centered periodic cells
- one-click useful figures and reproducible output settings

## Current baseline

The existing implementation is a good technical base. It already has:

- a local `pqviewer FILE` launch path
- file picker and drag-and-drop opening
- indexed PQ trajectory access with bounded frame prefetching
- a React and Three.js canvas with dense-scene fallbacks
- centered triclinic cells and periodic boundary bonds
- atom and whole-molecule wrapping
- ball-and-stick, space-filling, lines, and protein ribbon views
- water filtering, force and velocity vectors, and atom inspection
- ordered multi-selection with exact periodic distance, angle, and dihedral readouts
- a compact trajectory bar with speed, stride, once, loop, and rock playback
- command search, platform-aware shortcuts, and optional Vim navigation
- high-resolution PNG output
- 115 passing frontend tests, 43 passing backend tests, and a clean production build

The next gaps are deeper scientific workflows rather than rendering basics:

- box and semantic selection are not implemented
- measurements cannot yet be pinned or plotted
- cell-origin translation is not yet exposed
- broad ASE file and object interoperability is missing
- figures cannot yet be saved as reusable view recipes

## Experience design

### Visual thesis

A calm, light scientific instrument. The structure owns the screen. Neutral
surfaces and graphite text provide contrast; one clear accent marks actions and
state. Dark mode is optional, never the default.

The interface does not need to imitate the PQ logo. A small identity mark or
wordmark is enough. Recognition should come primarily from the product name,
scientific behavior, and overall quality.

Use one accent color, restrained shadows, crisp one-pixel dividers, and compact
typography. Do not use dashboard cards, decorative gradients, glowing controls,
or strong visual cueing.

### Content plan

The interface has five surfaces:

1. A 44 px top bar for quiet identity, Open, Search, View, and Figure
2. A full molecular canvas
3. A small selection bar when atoms are selected
4. A compact timeline only for multi-frame data
5. One contextual popover or inspector at a time

There is no permanent settings page. `View` opens its controls in one click.
`Details`, plots, and figure options reuse the same contextual sheet. Advanced
commands remain searchable.

### Interaction thesis

- Manipulate the structure directly: click, drag, scroll, select, and scrub.
- Reveal scientific actions from the current selection or data capability.
- Keep every state change reversible and close temporary UI with `Escape`.
- Use fast 120-180 ms transitions only to explain opening, closing, or selection.
- Make mouse, touchpad, keyboard, and Vim paths equally complete.

### Screen anatomy

```text
+-------------------------------------------------------------------+
| PQ  filename                     Open   Search   View   Figure      |
+-------------------------------------------------------------------+
|                                                                   |
|                         molecular canvas                           |
|                                                                   |
|  Fit / axes                                      contextual info  |
|                                                                   |
|       3 selected   1.42 A   Clear   Pin   Plot                     |
+-------------------------------------------------------------------+
|  previous  play  next  ----------------------  241 / 1200  more   |
+-------------------------------------------------------------------+
```

The selection bar and timeline appear only when relevant. A plot replaces the
lower portion of the canvas temporarily; it never becomes a permanent dashboard.

## Interaction model

### Canvas

- Click an atom to select it; click empty space to clear.
- `Shift`-click toggles atoms in the selection.
- Drag to rotate, secondary or middle drag to pan, and scroll to zoom.
- `Shift`-drag on empty space starts box selection.
- Double-click an atom or selection to center it.
- `F` fits; `1`, `2`, `3`, and `4` select perspective, XY, XZ, and YZ views.
- A small orientation tripod makes the fixed views discoverable by pointer.
- Hover shows a small identity label without changing selection.

Click and drag must be distinguished by a movement threshold so selection does
not fight camera rotation. Touchpad controls should follow browser and OS norms.

### Selection and measurement

Selection is the main bridge from viewing to scientific work.

- one atom: identity, position, charge, force, and velocity
- two atoms: distance
- three atoms: angle
- four atoms: ordered dihedral
- larger selection: formula, atom count, center, and extent

Measurements update as the trajectory moves. They can be pinned to the canvas,
copied, or plotted over the trajectory. Periodic measurements expose a clear
`Minimum image` toggle.

Selection scopes should include atom, element, molecule, residue, connected
component, and spatial range. The command search can express precise actions such
as `select oxygen`, `select water`, or `select within 3 A of selection`.

### Trajectory

The default timeline contains only transport and a scrubber:

- first, previous, play or pause, next, and last
- frame counter
- simulation step and physical time when known
- a compact `More` menu for speed, stride, loop, and rock
- frame bookmarks and selected ranges later

Do not show energy or another scalar automatically. A scientist opens a property
plot explicitly. When open, its cursor follows playback and clicking a point
changes the frame.

Camera, selection, representation, measurements, and display transforms persist
across frames. Playback never presents an old frame as if it were the requested
one.

### View controls

`View` is a single-click popover organized by what appears on the canvas:

- Representation: ball-and-stick, space-filling, lines, ribbon when available
- Context: cell, axes, labels, water, hydrogens
- Vectors: forces, velocities, scale, and color-by-magnitude
- Periodic: wrap mode, cell origin, mirror, and repeat
- Camera: projection, fixed views, fit, and saved view

Only supported controls appear. The first row should contain the common choices;
secondary values expand inline. There is no second `Customize` step.

### Search and keyboard

`Cmd/Ctrl+K`, `/`, and Vim `:` open the same command search. Results show their
shortcut and current state. Search covers every action, including controls that
are not visible.

An empty search shows at most six recent or context-relevant actions. Unavailable
commands are omitted instead of filling the list with disabled rows. Results may
be grouped quietly by View, Trajectory, Measure, and Figure.

Keep the current Linux and Vim support:

- `Space`: play or pause
- arrows or `h` and `l`: step frames
- `Shift` plus arrows: step ten frames
- `Home` or `gg`: first frame
- `End` or `G`: last frame
- `F`: fit
- `B`, `C`, `W`: bonds, cell, water
- `Escape` or `Ctrl+[`: close or clear current context
- `?`: shortcut reference

Do not map `j` and `k` to the same horizontal frame action as `h` and `l`.

Keyboard features should accelerate the interface, not be required to understand
it.

## Scientific display

PQViewer should choose a useful first representation without creating separate
application modes.

| System | Initial presentation | Nearby actions |
| --- | --- | --- |
| Molecule | centered ball-and-stick, cell hidden | labels, forces, measurement |
| Liquid | whole-molecule wrapping, cell visible | water, unwrap, RDF later |
| Crystal | cell and periodic context | repeat, align to lattice, polyhedra later |
| MOF | stable periodic bonds and centered cell | repeat, hide guests, coordination |
| Protein | ribbon plus ligand, water reduced | residue selection, surface later |

Automatic choices are visible, reversible, and saved in the view recipe.
They depend on system structure and topology, never on whether an energy or other
scalar sidecar happens to be present.

## PQ-specific advantages

### Correct centered cells

PQ's invariant is fractional `[-0.5, 0.5)`, including triclinic systems. It must
remain the internal convention, not a visual translation of an ASE-style cell.

One discrepancy should be fixed first: PQ wraps with `floor(f + 0.5)`, while the
current PQAnalysis implementation uses `round(f)`. Exact half-cell coordinates
can therefore land on different faces. PQAnalysis should expose one canonical
centered-wrap function matching PQ, and PQViewer should consume it.

Periodic display modes are non-destructive:

- original coordinates
- atoms wrapped into the centered cell
- whole molecules wrapped into the centered cell
- unwrapped trajectory motion
- movable displayed cell origin
- mirror along a, b, or c
- bounded supercell replication

Stable topology is the default. Reactive bond inference is an explicit mode so
bonds do not flicker around cutoffs during ordinary trajectories.

### Open a PQ run, not a pile of sidecars

PQ already writes a family of trajectory, force, velocity, charge, energy, info,
stress, and box files. The ecosystem should expose them as one run.

```text
PQ outputs or run manifest
        -> PQAnalysis RunDataset
              -> PQViewer
              -> PQEnalyzer
              -> scripts and notebooks

ASE Atoms, files, and trajectories
        -> ASE adapter -> PQViewer
```

PQAnalysis should own:

- `RunDescriptor`: files, engine, versions, status, and provenance
- `FrameKey`: index, simulation step, and optional physical time
- `IndexedTrajectorySource`: random access, iteration, and incremental refresh
- typed per-frame and per-atom properties with units
- the canonical centered-cell operations
- analysis results and scientific calculations

PQViewer should own:

- local server and binary transport
- rendering and interaction
- representations and display transforms
- plots and analysis presentation
- publication output and view recipes

PQViewer should never depend on PQEnalyzer.

## Delivery plan

### Milestone 0.2: interaction parity

Goal: make the viewer as immediately useful as ASE for everyday inspection.

- simplify the top bar and make `View` one click
- keep concise atom, frame, and PBC status visible when space permits
- remove the automatic property trace from the default timeline
- make automatic presentation depend on system type, not loaded scalar series
- rank command results by context and keep the empty palette short
- add multi-selection and box selection
- add distance, angle, and dihedral measurements
- add hover identity and optional atom labels
- add velocity vectors and vector legends
- add speed, stride, loop, and rock playback controls
- show frame, step, and physical time correctly
- add first, last, and frame-range navigation
- add an ASE object and file adapter, including `@start:stop:step`
- keep all commands in search and the shortcut sheet

Release gate:

```text
pqviewer trajectory.xyz
```

must let a scientist rotate, select, measure, navigate, inspect vectors, and save
a useful figure without opening documentation.

### Milestone 0.3: periodic systems done properly

- unify centered wrapping in PQ and PQAnalysis
- expose atom, molecule, and unwrapped display modes
- add movable cell origin, mirror, and bounded repeat controls
- keep selections and measurements valid across images
- make periodic measurement mode explicit
- preserve topology by default and add optional reactive inference
- add golden fixtures for orthorhombic and difficult triclinic cells
- use `acof1` as a visible regression: the structure must not appear stranded
  outside its displayed cell

### Milestone 0.4: trajectory understanding

- add frame keys and robust property alignment across restarts and gaps
- add selected-atom trails and displacement vectors
- add frame bookmarks and comparison to a reference frame
- open measurement and property plots on demand
- link plot cursor, selected atoms, and current frame bidirectionally
- expose RDF and coordination analysis through typed PQAnalysis results
- keep long trajectories lazy with workers and a bounded cache

### Milestone 0.5: publication figures

The normal export remains one click and produces a strong default. A single
Figure sheet exposes advanced output without changing the viewport UI.

- PNG and TIFF at exact pixel dimensions and DPI
- white, transparent, or chosen solid background
- orthographic or perspective camera
- smart framing that does not let an empty cell shrink the structure
- consistent atom materials, bonds, vectors, labels, legends, and scale bars
- SVG or PDF for plots and vector annotations
- a small JSON view recipe containing sources, frame, camera, selection,
  transforms, representation, and render settings
- deterministic headless rendering from that recipe
- frame sequences and video only after still-image output is reliable

Use one interactive renderer. Additional offline render backends are a later
adapter if they produce a clear scientific benefit; they should not fragment the
viewer or its settings.

### Milestone 1.0: ecosystem release

- `pqviewer trajectory.xyz`, `pqviewer run.in`, and `pqviewer run-directory/`
  resolve through the same run model
- Python API accepts ASE `Atoms`, ASE trajectories, and PQAnalysis datasets
- notebook embedding uses the same viewer state and renderer
- PyPI and conda-forge installation
- documented format and property support matrix
- examples for a molecule, liquid, crystal, MOF, protein, and long trajectory
- stable extension contracts for representations and analysis results

## Quality gates

Every milestone needs automated unit, integration, browser, and visual checks.

### Scientific correctness

- centered and triclinic wrapping against PQ reference calculations
- minimum-image distances and periodic bonds against executable references
- whole-molecule continuity across all cell faces
- explicit unit checks for forces, velocities, charge, time, pressure, and stress
- step and time alignment across truncated, restarted, and concatenated runs

### Interaction

- every visible action works by pointer and keyboard
- command search reaches every hidden action
- camera and selection remain stable during playback
- selection, measurements, and plots update on the same displayed frame
- focus order, contrast, reduced motion, and screen-reader names remain valid

### Stress matrix

- 2-atom molecule and single-frame files
- 100,000-atom liquid and protein scenes
- dense MOF or crystal with triclinic periodic bonds
- 10,000-frame trajectory without eager loading
- missing, partial, corrupt, and mismatched companion files
- rapid scrubbing, repeated file replacement, and interrupted requests
- high-resolution transparent and opaque exports

Targets:

- first useful frame in under one second for ordinary local files
- cached frame changes in under 100 ms
- smooth camera interaction for 100,000 atoms using adaptive detail
- bounded memory as trajectory length grows
- no stale-frame labels, WebGL context loss, or silent export failure

## Explicitly not now

- simulation setup or execution UI
- cluster and job management
- a MolarVerse dashboard
- a permanent energy panel
- a general-purpose file workspace
- coordinate editing or calculator setup
- embedding PQEnalyzer's interface
- duplicating PQAnalysis calculations in TypeScript
- multiple viewport rendering engines
- broad parity with every VMD, OVITO, or ChimeraX plugin

## Reference behavior

- [ASE GUI basics](https://docs.ase-lib.org/ase/gui/basics.html)
- [ASE view controls](https://docs.ase-lib.org/ase/gui/view.html)
- [ASE movie, graphs, wrapping, and rendering](https://docs.ase-lib.org/ase/gui/tools.html)
- [ASE file I/O](https://docs.ase-lib.org/ase/io/io.html)
- [ASE visualization interface](https://gitlab.com/ase/ase/blob/master/doc/ase/visualize/visualize.rst)
- [OVITO non-destructive pipeline](https://ovito.org/manual/usage/pipeline.html)
- [ChimeraX selection model](https://www.rbvi.ucsf.edu/chimerax/docs/user/selection.html)
