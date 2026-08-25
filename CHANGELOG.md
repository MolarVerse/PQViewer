# Changelog

PQViewer follows [Semantic Versioning](https://semver.org/). This file records
user-visible changes.

## [Unreleased]

### Fixed

- Reset the display when a new file is opened so crystal and MOF settings do not leak
- Choose the MOF preset for larger periodic frameworks that do not have coordination polyhedra
- Allow pair distribution and coordination on a single fully periodic frame
- Turn bonds on when switching to ball-and-stick, licorice, or lines
- Hide hydrogen, residue, and chain controls when they do not apply
- Color protein ribbons by secondary structure by default
- Jump to an atom from search by 1-based index or atom label
- Keep empty search suggestions on the current structure instead of trajectory bookmarks
- Hide duplicate View/Edit/Analyze tabs in the inspector on wide layouts
- Treat Export as a quiet header action until the figure sheet is open
- Show the Bonds switch as off when the current representation does not use bonds
- Ignore `?renderer=three` so interactive viewing stays on 3Dmol

### Changed

- Capitalize the Python distribution name as `MolarVerse-PQViewer`
- Put representation, atoms, and layers first in View, with the periodic cell and appearance last
- Move interactive quality next to light and dark appearance
- Enlarge inspector labels and controls from 9–10 px to 11–12 px and load Inter at regular weights
- Ship only Latin, Latin-extended, and Greek Inter files

## [0.1.0] - 2026-08-06

Initial public beta.

### Added

- Renderer abstraction with locally bundled 3Dmol.js
- Local viewer for PQ trajectories, inputs, run directories, and restart chains
- Optional ASE file and object adapter
- Jupyter notebook integration and a static web demo
- Indexed trajectory playback and stable frame identity
- PQ-centered orthorhombic and triclinic periodic display
- Atom, molecule, source, and continuous unwrapped coordinates
- Cell centering, mirroring, and bounded repeats
- Scientific selection, periodic measurements, pinned comparisons, and plots
- Frame bookmarks, reference displacement, and atom trails
- Pair-distribution and coordination analysis through PQAnalysis
- Forces, velocities, charges, water controls, and protein ribbons
- Command search, keyboard shortcuts, and optional Vim navigation
- Publication PNG and TIFF figures, vector plot exports, and figure recipes
- Source-validated headless rendering
