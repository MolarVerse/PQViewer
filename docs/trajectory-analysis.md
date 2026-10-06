# Trajectory analysis

Interactive measurements are evaluated in the viewer. Pair-distribution and
coordination calculations use PQAnalysis on the server.

## Measurements over frames

Select two, three, or four atoms in order, then choose **Plot** for a distance,
angle, or dihedral. The curve loads incrementally; its cursor follows the
displayed frame, and selecting a point changes frames.

Periodic measurements use minimum-image geometry by default. A curve keeps the
mode chosen when it was created. Choose **Pin** to retain a measurement and
compare compatible pinned curves: distances together, or angular measurements
together.

Complete curves export as CSV, SVG, or vector PDF. Frame index is not physical
time unless the source supplies time and its unit.

## Reference frames and trails

| Action | Result |
| --- | --- |
| Timeline menu or `M` | Bookmark the current source/frame identity |
| **Set as reference**, then **Show displacement** | Compare selected atoms with a saved frame |
| **Track** | Show selected atom paths over the previous 50 frames and current position |

Tracking uses unwrapped motion when available and allows sixteen selected atom
images. A reference whose saved source identity no longer matches is cleared.
See [vacuum and unwrapping limits](data-and-conventions.md#partial-cells-and-vacuum).

## Scalar properties

Numeric frame properties from trajectory metadata or energy/info companions
appear under **Plot** in the timeline menu. Their cursor follows playback;
selecting a point navigates to its frame. Units come from the source.

## Pair distribution and coordination

Use a file-backed structure or trajectory with all three axes periodic and a
finite cell volume. A single frame is sufficient. Every sampled frame must
meet the periodic-cell requirement.

Open **Pair distribution** or **Coordination** from the timeline menu, selection
bar, or command search.

| Setting | Meaning |
| --- | --- |
| **From** | Reference atoms, population A |
| **To** | Target atoms counted around A, population B |
| **Frames** | All, last 100, or last 1,000 when available |
| **Bins** | Number of equal-width radial shells |
| **r max · Å** | Upper radius in Å; blank uses the backend default |

**All** applies a uniform stride when there are more than 10,000 frames.
For another interval or stride, open a slice first:

```bash
pqviewer 'trajectory.xyz@100:1000:10'
```

Results average the sampled frames and are independent of the current playback
cursor. They export as CSV, SVG, and vector PDF.

### Quantities and normalization

Let `F` be the sampled frame count, `N_A` and `N_B` the population sizes, and
`H_k` the total ordered A-to-B pair count in radial shell `k` across those
frames. Self-pairs are excluded; intramolecular pairs are included.

For shell edges `r_k` and `r_(k+1)`, PQAnalysis uses:

```{math}
\Delta V_k = \frac{4\pi}{3}\left(r_{k+1}^3-r_k^3\right),\qquad
\rho_B = \frac{N_B}{\langle V\rangle},
```

```{math}
g_k = \frac{H_k}{F N_A\rho_B\Delta V_k},\qquad
N(r_{k+1}) = \frac{\sum_{j=0}^{k} H_j}{F N_A}.
```

| Curve | Radius | Unit |
| --- | --- | --- |
| `g(r)` | Shell centre | Dimensionless |
| Coordination `N(r)` | Shell's outer edge | Neighbors per reference atom |

`<V>` is the arithmetic mean of sampled cell volumes. For changing volumes,
this normalizes the accumulated histogram using one mean density; it is not an
average of separately normalized per-frame curves.

The target density uses `N_B` even when A and B overlap. For identical
populations in a fixed-volume ideal gas, the finite-population baseline is
`(N_B - 1) / N_B` because self-pairs are excluded. No uncertainty estimate is
supplied; correlated frames do not provide independent samples.

### Radius and work limits

The backend chooses at most half the shortest supplied lattice-vector length
across the sampled cells and clamps larger requested radii to that value. This
rule alone does not ensure complete spherical shells in a strongly skewed
cell; choose a radius within half of every perpendicular cell-face separation.
PQAnalysis images pair displacements by centering fractional components, so
this radius restriction matters even when interactive measurements find the
shortest Cartesian image.

| Bound | Maximum |
| --- | --- |
| Atoms in each population | 4,096 |
| Sampled frames | 10,000 |
| Bins in the interface | 2,000, with a minimum of 20 |
| Frame/reference/target pair evaluations | 50 million |
| Reconstructed atom-frames for sliced, ASE, or other non-native sources | 5 million |

Use a shorter frame preset or smaller populations when a work limit is reached.
Three-dimensional shell normalization is unavailable for vacuum, slab, or wire
boundary conditions.
