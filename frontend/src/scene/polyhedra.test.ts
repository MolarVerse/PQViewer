import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCellBasis, prepareScene } from "./model";
import type { FrameData, Manifest, ScenePresentation } from "../types";
import {
  buildCoordinationPolyhedraGeometry,
  hasCoordinationPolyhedra,
  inferCoordinationPolyhedra,
  prepareCoordinationPolyhedraTopology,
  type CoordinationPolyhedraInput,
} from "./polyhedra";

function input(
  positions: number[][],
  atomicNumbers: number[],
  bonds: Array<[number, number]>,
): CoordinationPolyhedraInput {
  return {
    positions: new Float32Array(positions.flat()),
    atomicNumbers,
    bonds,
    basis: null,
    pbc: [false, false, false],
  };
}

function starBonds(coordination: number): Array<[number, number]> {
  return Array.from({ length: coordination }, (_, index) => [0, index + 1]);
}

function roundedEdgeKey(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  left: number,
  right: number,
): string {
  const point = (index: number) => [
    position.getX(index).toFixed(5),
    position.getY(index).toFixed(5),
    position.getZ(index).toFixed(5),
  ].join(",");
  return [point(left), point(right)].sort().join("|");
}

function expectClosedTriangles(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute("position");
  const edges = new Map<string, number>();
  for (let triangle = 0; triangle < position.count / 3; triangle += 1) {
    const start = triangle * 3;
    for (const [left, right] of [
      [start, start + 1],
      [start + 1, start + 2],
      [start + 2, start],
    ]) {
      const key = roundedEdgeKey(position, left, right);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  expect([...edges.values()].every((count) => count === 2)).toBe(true);
}

describe("coordination polyhedra", () => {
  it("builds octahedra for the NaCl showcase through the viewer model", () => {
    const lines = readFileSync(
      resolve(process.cwd(), "../docs/assets/sources/nacl.extxyz"),
      "utf8",
    ).trim().split(/\r?\n/);
    const atomCount = Number.parseInt(lines[0], 10);
    const coordinates = lines.slice(2, atomCount + 2).map((line) => {
      const [symbol, x, y, z] = line.trim().split(/\s+/);
      return { symbol, position: [Number(x), Number(y), Number(z)] };
    });
    const manifest = {
      schema_version: 1,
      name: "nacl.extxyz",
      frame_count: 1,
      topology: {
        atom_count: atomCount,
        atomic_numbers: coordinates.map(({ symbol }) => symbol === "Na" ? 11 : 17),
        symbols: coordinates.map(({ symbol }) => symbol),
        bonds: [],
        bond_source: "inferred",
      },
      series: [],
    } as Manifest;
    const frame = {
      header: { arrays: [], pbc: [true, true, true] },
      arrays: new Map([
        ["positions", new Float32Array(coordinates.flatMap(({ position }) => position))],
        ["cell", new Float32Array([11.28, 0, 0, 0, 11.28, 0, 0, 0, 11.28])],
      ]),
    } as FrameData;
    const presentation: ScenePresentation = {
      mode: "polyhedra",
      water: "show",
      hydrogens: true,
      wrap: "atom",
      cellOrigin: [0, 0, 0],
      mirror: [false, false, false],
      images: { min: [0, 0, 0], max: [0, 0, 0] },
      cell: true,
      forces: false,
      velocities: false,
      atomScale: 1,
      bondScale: 1,
      color: "element",
      quality: "high",
    };
    const model = prepareScene(manifest, frame, presentation);
    expect(model).not.toBeNull();
    expect(model!.bonds).toHaveLength(384);
    const topology = prepareCoordinationPolyhedraTopology(model!);
    expect(topology.candidates).toHaveLength(32);
    expect(topology.adjacency.size).toBe(32);
    expect(hasCoordinationPolyhedra(model!, {}, topology)).toBe(true);
    const polyhedra = inferCoordinationPolyhedra(model!);
    expect(polyhedra).toHaveLength(32);
    expect(polyhedra.every(({ coordinationNumber }) => coordinationNumber === 6)).toBe(true);
    expect(
      inferCoordinationPolyhedra(model!, {}, topology)
        .map(({ centerAtom, coordinationNumber }) => [centerAtom, coordinationNumber]),
    ).toEqual(
      polyhedra.map(({ centerAtom, coordinationNumber }) => [centerAtom, coordinationNumber]),
    );
    expect(buildCoordinationPolyhedraGeometry(model!, {}, topology)).not.toBeNull();
  });

  it("builds a closed tetrahedron with center picking and color attributes", () => {
    const model = input(
      [
        [0, 0, 0],
        [1, 1, 1],
        [-1, -1, 1],
        [-1, 1, -1],
        [1, -1, -1],
      ],
      [14, 8, 8, 8, 8],
      starBonds(4),
    );
    const polyhedra = inferCoordinationPolyhedra(model);
    expect(polyhedra).toHaveLength(1);
    expect(polyhedra[0].coordinationNumber).toBe(4);
    expect(polyhedra[0].triangles).toHaveLength(4);

    const geometry = buildCoordinationPolyhedraGeometry(model, {
      colorForCenter: () => "#287f9b",
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.getAttribute("position").count).toBe(12);
    expect(geometry!.getAttribute("atomIndex").count).toBe(12);
    expect(geometry!.getAttribute("centerAtomIndex").getX(0)).toBe(0);
    expect(geometry!.getAttribute("coordinationNumber").getX(0)).toBe(4);
    const color = geometry!.getAttribute("color");
    expect(color.getX(0)).toBeCloseTo(new THREE.Color("#287f9b").r);
    expectClosedTriangles(geometry!);
  });

  it("reuses a prepared topology without changing inference or geometry", () => {
    const model = input(
      [
        [0, 0, 0],
        [1, 1, 1],
        [-1, -1, 1],
        [-1, 1, -1],
        [1, -1, -1],
      ],
      [14, 8, 8, 8, 8],
      starBonds(4),
    );
    const options = {
      centerAtomicNumbers: [14],
      colorForCenter: () => "#c46c3b",
    };
    const topology = prepareCoordinationPolyhedraTopology(model, options);
    const direct = inferCoordinationPolyhedra(model, options);
    const prepared = inferCoordinationPolyhedra(model, options, topology);
    expect(prepared).toEqual(direct);

    const directGeometry = buildCoordinationPolyhedraGeometry(model, options);
    const preparedGeometry = buildCoordinationPolyhedraGeometry(model, options, topology);
    expect(preparedGeometry).not.toBeNull();
    expect(
      (preparedGeometry!.getAttribute("position") as THREE.BufferAttribute).array,
    ).toEqual(
      (directGeometry!.getAttribute("position") as THREE.BufferAttribute).array,
    );
    expect(preparedGeometry!.userData).toEqual(directGeometry!.userData);
    directGeometry!.dispose();
    preparedGeometry!.dispose();
  });

  it("unwraps an octahedron across a periodic boundary", () => {
    const model = input(
      [
        [4.8, 0, 0],
        [-4.2, 0, 0],
        [3.8, 0, 0],
        [4.8, 1, 0],
        [4.8, -1, 0],
        [4.8, 0, 1],
        [4.8, 0, -1],
      ],
      [26, 8, 8, 8, 8, 8, 8],
      starBonds(6),
    );
    model.basis = createCellBasis(new Float32Array([
      10, 0, 0,
      0, 10, 0,
      0, 0, 10,
    ]));
    model.pbc = [true, true, true];

    const polyhedra = inferCoordinationPolyhedra(model);
    expect(polyhedra).toHaveLength(1);
    expect(polyhedra[0].triangles).toHaveLength(8);
    expect(Math.min(...polyhedra[0].vertices.map((point) => point.x))).toBeCloseTo(3.8);
    expect(Math.max(...polyhedra[0].vertices.map((point) => point.x))).toBeCloseTo(5.8);
    const geometry = buildCoordinationPolyhedraGeometry(model);
    expect(geometry!.getAttribute("position").count).toBe(24);
    expectClosedTriangles(geometry!);
  });

  it("reconstructs repeated ligand images in a primitive NaCl cell", () => {
    const half = 2.82;
    const model = input(
      [
        [0, 0, 0],
        [half, 0, 0],
      ],
      [11, 17],
      [[0, 1]],
    );
    model.basis = createCellBasis(new Float32Array([
      0, half, half,
      half, 0, half,
      half, half, 0,
    ]));
    model.pbc = [true, true, true];

    const topology = prepareCoordinationPolyhedraTopology(model);
    expect(hasCoordinationPolyhedra(model, {}, topology)).toBe(true);
    const polyhedra = inferCoordinationPolyhedra(model, {}, topology);
    expect(polyhedra).toHaveLength(1);
    expect(polyhedra[0].centerAtom).toBe(0);
    expect(polyhedra[0].coordinationNumber).toBe(6);
    expect(new Set(polyhedra[0].ligandAtoms)).toEqual(new Set([1]));
    expect(polyhedra[0].triangles).toHaveLength(8);
    expectClosedTriangles(buildCoordinationPolyhedraGeometry(model, {}, topology)!);
  });

  it("triangulates square faces once for cubic coordination", () => {
    const corners = [-1, 1].flatMap((x) => (
      [-1, 1].flatMap((y) => [-1, 1].map((z) => [x, y, z]))
    ));
    const model = input(
      [[0, 0, 0], ...corners],
      [11, ...Array(8).fill(17)],
      starBonds(8),
    );
    const polyhedra = inferCoordinationPolyhedra(model);
    expect(polyhedra).toHaveLength(1);
    expect(polyhedra[0].triangles).toHaveLength(12);
    const geometry = buildCoordinationPolyhedraGeometry(model)!;
    expectClosedTriangles(geometry);
    expect(geometry.userData.edgePositions).toBeInstanceOf(Float32Array);
    expect(geometry.userData.edgePositions).toHaveLength(12 * 2 * 3);
  });

  it("renders a three-coordinate environment as a ligand polygon", () => {
    const model = input(
      [
        [0, 0, 0.7],
        [1, 0, 0],
        [-0.5, 0.866, 0],
        [-0.5, -0.866, 0],
      ],
      [5, 8, 8, 8],
      starBonds(3),
    );
    const polyhedra = inferCoordinationPolyhedra(model);
    expect(polyhedra).toHaveLength(1);
    expect(polyhedra[0].triangles).toHaveLength(1);
    expect([...polyhedra[0].vertexAtoms].sort()).toEqual([1, 2, 3]);
    expect(buildCoordinationPolyhedraGeometry(model)!.getAttribute("position").count).toBe(3);
  });

  it("supports planar coordination and rejects coincident or unsuitable centers", () => {
    const squarePlanar = input(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [-1, 0, 0],
        [0, -1, 0],
      ],
      [29, 8, 8, 8, 8],
      starBonds(4),
    );
    expect(inferCoordinationPolyhedra(squarePlanar)[0].triangles).toHaveLength(2);
    expect(hasCoordinationPolyhedra(squarePlanar)).toBe(true);

    const coincident = input(
      [
        [0, 0, 0],
        [1, 1, 1],
        [1, 1, 1],
        [-1, 1, -1],
        [1, -1, -1],
      ],
      [14, 8, 8, 8, 8],
      starBonds(4),
    );
    expect(inferCoordinationPolyhedra(coincident)).toEqual([]);
    expect(hasCoordinationPolyhedra(coincident)).toBe(false);

    const methane = input(
      [
        [0, 0, 0],
        [1, 1, 1],
        [-1, -1, 1],
        [-1, 1, -1],
        [1, -1, -1],
      ],
      [6, 1, 1, 1, 1],
      starBonds(4),
    );
    expect(inferCoordinationPolyhedra(methane)).toEqual([]);
    const automaticTopology = prepareCoordinationPolyhedraTopology(methane);
    expect(automaticTopology.candidates).toEqual([]);
    expect(automaticTopology.adjacency.size).toBe(0);
    expect(hasCoordinationPolyhedra(methane, {}, automaticTopology)).toBe(false);
    const explicitOptions = { centerAtoms: [0] };
    const explicitTopology = prepareCoordinationPolyhedraTopology(
      methane,
      explicitOptions,
    );
    expect(
      inferCoordinationPolyhedra(methane, explicitOptions, explicitTopology),
    ).toHaveLength(1);
    expect(
      hasCoordinationPolyhedra(methane, explicitOptions, explicitTopology),
    ).toBe(true);
  });

  it("does not reuse a topology for filtered bonds or center filters", () => {
    const model = input(
      [
        [0, 0, 0],
        [1, 1, 1],
        [-1, -1, 1],
        [-1, 1, -1],
        [1, -1, -1],
      ],
      [14, 8, 8, 8, 8],
      starBonds(4),
    );
    const topology = prepareCoordinationPolyhedraTopology(model);
    expect(hasCoordinationPolyhedra(model, {}, topology)).toBe(true);

    const filtered = {
      ...model,
      bonds: model.bonds.slice(0, 2),
    };
    expect(hasCoordinationPolyhedra(filtered)).toBe(false);
    expect(hasCoordinationPolyhedra(filtered, {}, topology)).toBe(false);
    expect(inferCoordinationPolyhedra(filtered, {}, topology)).toEqual([]);
    expect(
      hasCoordinationPolyhedra(model, { centerAtomicNumbers: [26] }, topology),
    ).toBe(false);
  });

  it("caps complete polyhedra and periodic copies", () => {
    const positions: number[][] = [];
    const atomicNumbers: number[] = [];
    const bonds: Array<[number, number]> = [];
    for (let center = 0; center < 6; center += 1) {
      const offset = positions.length;
      const x = center * 5;
      positions.push(
        [x, 0, 0],
        [x + 1, 1, 1],
        [x - 1, -1, 1],
        [x - 1, 1, -1],
        [x + 1, -1, -1],
      );
      atomicNumbers.push(14, 8, 8, 8, 8);
      for (let ligand = 1; ligand <= 4; ligand += 1) bonds.push([offset, offset + ligand]);
    }
    const model = input(positions, atomicNumbers, bonds);
    const sampled = inferCoordinationPolyhedra(model, { maxCenters: 2 });
    expect(sampled.map(({ centerAtom }) => centerAtom)).toEqual([10, 25]);

    const geometry = buildCoordinationPolyhedraGeometry(model, {
      maxCenters: 2,
      maxTriangles: 12,
      images: [[0, 0, 0], [1, 0, 0]],
    });
    expect(geometry!.userData.triangleCount).toBe(12);
    expect(geometry!.userData.polyhedronCount).toBe(3);
    expect(geometry!.getAttribute("position").count).toBe(36);
  });

  it("uses the same candidate sampling for exact availability checks", () => {
    const positions = Array.from({ length: 9 }, (_, atom) => [atom * 10, 0, 0]);
    positions.push(
      [81, 1, 1],
      [79, -1, 1],
      [79, 1, -1],
      [81, -1, -1],
    );
    const model = input(
      positions,
      [...Array(9).fill(14), ...Array(4).fill(8)],
      Array.from({ length: 4 }, (_, ligand) => [8, ligand + 9]),
    );
    const options = {
      centerAtoms: Array.from({ length: 9 }, (_, atom) => atom),
      maxCenters: 2,
    };
    const topology = prepareCoordinationPolyhedraTopology(model, options);
    expect(topology.candidates).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...topology.adjacency.keys()]).toEqual([8]);
    expect(inferCoordinationPolyhedra(model, options, topology)).toHaveLength(1);
    expect(hasCoordinationPolyhedra(model, options, topology)).toBe(true);
    expect(
      inferCoordinationPolyhedra(
        model,
        { ...options, maxCenters: 1 },
        topology,
      ),
    ).toEqual([]);
    expect(
      hasCoordinationPolyhedra(
        model,
        { ...options, maxCenters: 1 },
        topology,
      ),
    ).toBe(false);
  });

  it("keeps prepared adjacency sparse for a large mostly ineligible structure", () => {
    const atomCount = 50_000;
    const positions = new Float32Array(atomCount * 3);
    positions.set([
      0, 0, 0,
      1, 1, 1,
      -1, -1, 1,
      -1, 1, -1,
      1, -1, -1,
    ]);
    const atomicNumbers = Array(atomCount).fill(6);
    atomicNumbers[0] = 14;
    atomicNumbers.fill(8, 1, 5);
    const bonds: Array<[number, number]> = starBonds(4);
    for (let atom = 5; atom + 1 < atomCount; atom += 1) {
      bonds.push([atom, atom + 1]);
    }
    const model: CoordinationPolyhedraInput = {
      positions,
      atomicNumbers,
      bonds,
      basis: null,
      pbc: [false, false, false],
    };

    const topology = prepareCoordinationPolyhedraTopology(model);
    expect(topology.candidates).toEqual([0]);
    expect(topology.adjacency.size).toBe(1);
    expect(topology.adjacency.get(0)).toEqual([1, 2, 3, 4]);
    expect(hasCoordinationPolyhedra(model, {}, topology)).toBe(true);
    expect(inferCoordinationPolyhedra(model, {}, topology)).toHaveLength(1);
  });
});
