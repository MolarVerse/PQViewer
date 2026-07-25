# Trajectory analysis

PQViewer keeps trajectory inspection next to the molecular view. Pair
distribution and coordination calculations run through PQAnalysis; interactive
selection geometry and measurements are evaluated in the viewer.

## Measurements over time

Select two, three, or four atoms in order, then choose **Plot**. The resulting
distance, angle, or dihedral curve loads incrementally and follows the displayed
frame.

Exports are available after the curve is complete:

- CSV for numeric values
- SVG for an editable vector plot
- PDF for a vector publication plot

Choose **Pin** to retain a measurement. Two or more compatible pinned
measurements can be compared in one plot. Distance measurements compare with
distance measurements; angular measurements compare together.

Periodic measurements use minimum-image geometry by default. A plot preserves
the measurement mode used when it was created.

## Bookmarks and reference frames

Use the timeline menu or `M` to bookmark a frame. A bookmark retains stable
source, segment, step, and time identity when available.

Choose **Set as reference** to compare the current structure with another
frame. Select atoms and choose **Show displacement** to draw their motion from
the reference. If the source changes and the saved frame identity no longer
matches, the stale reference is cleared.

## Atom trails

Select atoms and choose **Track** to draw their positions over the previous 50
frames plus the current position. Tracking uses unwrapped motion where available
and is limited to sixteen selected atom images.

## Scalar properties

Numeric frame properties from trajectory metadata or energy/info companions
appear under **Plot** in the timeline menu. Opening one does not change the
structural display. The plot cursor follows playback, and selecting a point
navigates to that frame.

## Pair distribution and coordination

Pair analysis requires a multi-frame, file-backed trajectory with a full
three-dimensional periodic cell.

Open **Pair distribution** or **Coordination** from the timeline menu, selection
bar, or command search. In the setup:

- **From** is the reference population around which neighbors are counted.
- **To** is the target population being counted.
- **Frames** selects all frames, the last 100, or the last 1,000 when available.
  **All** samples automatically when the trajectory exceeds 10,000 frames.
- **Bins** controls radial resolution.
- **r max · Å** sets the maximum radius; leave it automatic to use the safe
  periodic range.

The result switches between `g(r)` and integrated coordination `N(r)`. It
exports CSV, SVG, and vector PDF.

The calculation is intentionally bounded:

- at most 4,096 atoms in each population
- at most 10,000 sampled frames
- 20–2,000 bins in the interface
- at most 50 million frame/reference/target pair evaluations
- at most 5 million reconstructed atom-frames for sliced, ASE, and other
  non-native sources

Choose a shorter frame preset or smaller populations if the requested
calculation exceeds a work limit. Pair-analysis curves aggregate the selected
frames and do not follow one current-frame cursor.

For a custom interval or stride, open a sliced source such as
`trajectory.xyz@100:1000:10` before starting the analysis.
