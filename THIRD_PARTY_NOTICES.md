# Third-party notices

## Lucide

PQViewer bundles icons from Lucide React 1.27.0.

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Some Lucide icons are derived from the Feather project:

MIT License

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 3Dmol.js

PQViewer bundles 3Dmol.js 2.5.5 for interactive molecular rendering.

BSD 3-Clause License

Copyright (c) 2014, University of Pittsburgh and contributors
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

## PQAnalysis example data

`examples/acof-triclinic.xyz` contains the first four frames of the PQAnalysis
[`examples/traj2box/acof_triclinic.xyz`](https://github.com/MolarVerse/PQAnalysis/blob/main/examples/traj2box/acof_triclinic.xyz)
example. The ACOF documentation render uses its first frame.

The UMCM-9 documentation render and workspace screenshot use frame 1 of the
100-frame PQAnalysis
[`examples/traj2comtraj/umcm-9-md-01.xyz`](https://github.com/MolarVerse/PQAnalysis/blob/main/examples/traj2comtraj/umcm-9-md-01.xyz)
trajectory.

MIT License

Copyright (c) 2023 Jakob Gamper, Josef M. Gallmetzer, Clarissa A. Seidler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Protein Data Bank entry 1CRN

`docs/assets/sources/1CRN.pdb` and the corresponding render were produced from
the Crambin structure in PDB entry
[1CRN](https://www.rcsb.org/structure/1CRN). PDB archive data files are made
available under the
[CC0 1.0 dedication](https://www.rcsb.org/pages/policies). The structure should
be cited as:

> Hendrickson, W. A. & Teeter, M. M. Structure of the hydrophobic protein
> crambin determined directly from the anomalous scattering of sulphur.
> *Nature* **290**, 107–113 (1981).

## Demonstration geometries

The C60 fullerene, NaCl supercell, and illustrative water box shown in the
documentation were generated with
[ASE 3.29.0](https://wiki.fysik.dtu.dk/ase/) and rendered by PQViewer:

- C60 uses `ase.build.molecule("C60")`.
- NaCl uses `ase.build.bulk("NaCl", "rocksalt", a=5.64, cubic=True)` repeated
  twice along each axis.
- The water box places 27 `ase.build.molecule("H2O")` geometries on a
  3 × 3 × 3 grid in a 12 Å cubic cell, with rotations from random seed 42.

These are visual examples, not simulation results. Their exact geometries and
portable PQViewer figure recipes are stored in `docs/assets/sources` and
`docs/assets/recipes`. Each recipe reproduces a 2,400 × 1,800 px PNG at
300 DPI.
