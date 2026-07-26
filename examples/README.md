# Example data

The examples are small fixtures for checking the viewer:

| File | Purpose | Provenance |
| --- | --- | --- |
| `water.xyz` | Molecule and short-trajectory smoke test | Synthetic PQViewer fixture |
| `periodic-boundary.extxyz` | Centered cell, forces, time, and minimum image | Synthetic PQViewer fixture |
| `periodic-boundary.in` | PQ input resolution | Synthetic PQViewer fixture |
| `periodic-crossing.extxyz` | Continuous motion across a periodic boundary | Synthetic PQViewer fixture |
| `acof-triclinic.xyz` | Triclinic framework, wrapping, and dense-scene regression | First four frames of the PQAnalysis `acof_triclinic.xyz` example |

The synthetic fixtures were created for this repository and are covered by its
MIT License.

`acof-triclinic.xyz` is reproduced from
[PQAnalysis](https://github.com/MolarVerse/PQAnalysis/blob/main/examples/traj2box/acof_triclinic.xyz),
copyright 2023 Jakob Gamper, Josef M. Gallmetzer, and Clarissa A. Seidler. It is
used under the MIT License. The complete upstream notice is in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
