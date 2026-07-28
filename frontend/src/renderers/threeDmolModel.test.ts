import { describe, expect, it } from "vitest";
import { prepareScene } from "../scene/model";
import type { FrameData, Manifest, ScenePresentation } from "../types";
import {
  buildDmolScenePlan,
  selectedDmolPositions,
  selectionFromDmolAtom,
} from "./threeDmolModel";

const presentation: ScenePresentation = {
  mode: "ball-stick",
  water: "show",
  hydrogens: true,
  wrap: "atom",
  cellOrigin: [0, 0, 0],
  mirror: [false, false, false],
  images: { min: [0, 0, 0], max: [0, 0, 0] },
  cell: true,
  bonds: true,
  forces: false,
  velocities: false,
  atomScale: 1,
  bondScale: 1,
  color: "element",
  quality: "auto",
};

describe("3Dmol scene plan", () => {
  it("keeps PQ's centered periodic cell without drawing through its boundary", () => {
    const data = frame(
      [4.8, 0, 0, -4.8, 0, 0],
      [10, 0, 0, 0, 8, 0, 0, 0, 6],
      [true, true, true],
    );
    const source = manifest([8, 1], [[0, 1]]);
    const scene = prepareScene(source, data, presentation)!;
    const plan = buildDmolScenePlan(source, scene, presentation);

    expect(plan.cellSegments).toHaveLength(12);
    expect(plan.boundaryBondCount).toBe(1);
    expect(plan.bondSegments).toHaveLength(0);
    expect(plan.shapeBondSegments).toHaveLength(0);
    const cellCoordinates = plan.cellSegments.flatMap(({ from, to }) => [
      from.x, from.y, from.z, to.x, to.y, to.z,
    ]);
    expect(Math.min(...cellCoordinates)).toBe(-5);
    expect(Math.max(...cellCoordinates)).toBe(5);
  });

  it("draws boundary bonds only between included neighboring cells", () => {
    const data = frame(
      [4.8, 0, 0, -4.8, 0, 0],
      [10, 0, 0, 0, 8, 0, 0, 0, 6],
      [true, true, true],
    );
    const source = manifest([8, 1], [[0, 1]]);
    const repeated: ScenePresentation = {
      ...presentation,
      images: { min: [0, 0, 0], max: [1, 0, 0] },
    };
    const scene = prepareScene(source, data, repeated)!;
    const plan = buildDmolScenePlan(source, scene, repeated);

    expect(plan.boundaryBondCount).toBe(1);
    expect(plan.bondSegments).toHaveLength(1);
    expect(plan.shapeBondSegments).toHaveLength(1);
    expect(plan.shapeBondSegments[0].from.distanceTo(plan.shapeBondSegments[0].to))
      .toBeCloseTo(0.4, 5);
  });

  it("removes native and periodic bonds when the bond layer is hidden", () => {
    const data = frame(
      [0, 0, 0, 1.2, 0, 0, 4.8, 0, 0, -4.8, 0, 0],
      [10, 0, 0, 0, 8, 0, 0, 0, 6],
      [true, true, true],
    );
    const source = manifest([6, 6, 8, 1], [[0, 1], [2, 3]]);
    const hidden = { ...presentation, bonds: false };
    const scene = prepareScene(source, data, hidden)!;
    const plan = buildDmolScenePlan(source, scene, hidden);

    expect(plan.atoms.every((atom) => atom.bonds.length === 0)).toBe(true);
    expect(plan.bondSegments).toHaveLength(0);
    expect(plan.shapeBondSegments).toHaveLength(0);
    expect(plan.boundaryBondCount).toBe(1);
  });

  it("keeps atom and image identity on every rendered copy", () => {
    const data = frame(
      [0, 0, 0],
      [4, 0, 0, 0, 4, 0, 0, 0, 4],
      [true, true, true],
    );
    const source = manifest([6]);
    const scene = prepareScene(source, data, {
      ...presentation,
      images: { min: [-1, 0, 0], max: [1, 0, 0] },
    })!;
    const plan = buildDmolScenePlan(source, scene, presentation);

    expect([...plan.selections].sort((left, right) => left.image[0] - right.image[0])).toEqual([
      { atom: 0, image: [-1, 0, 0] },
      { atom: 0, image: [0, 0, 0] },
      { atom: 0, image: [1, 0, 0] },
    ]);
    expect(plan.atoms.map(selectionFromDmolAtom)).toEqual(plan.selections);
    expect(plan.shapeBondSegments).toHaveLength(0);
    const positiveImage = plan.selections.find(({ image }) => image[0] === 1)!;
    expect(selectedDmolPositions(scene, [positiveImage])).toEqual(
      new Float64Array([4, 0, 0]),
    );
  });

  it("marks close nonbonded contacts without confusing bonds for collisions", () => {
    const data = frame([0, 0, 0, 0.2, 0, 0, 2, 0, 0]);
    const source = manifest([1, 1, 1], [[1, 2]]);
    const scene = prepareScene(source, data, presentation)!;
    const plan = buildDmolScenePlan(source, scene, presentation);

    expect(plan.collisionSegments).toHaveLength(1);
    expect(plan.collisionSegments[0].from.x).toBe(0);
    expect(plan.collisionSegments[0].to.x).toBeCloseTo(0.2);
  });

  it("finds close contacts through a skewed triclinic cell", () => {
    const data = frame(
      [0, 0, 0, 9.31, 0.49, 0],
      [10, 0, 0, 9, 1, 0, 0, 0, 10],
      [true, true, true],
    );
    const source = manifest([6, 6]);
    const scene = prepareScene(source, data, presentation)!;
    const plan = buildDmolScenePlan(source, scene, presentation);

    expect(plan.collisionSegments).toHaveLength(1);
    expect(plan.collisionSegments[0].from.distanceTo(plan.collisionSegments[0].to))
      .toBeCloseTo(Math.hypot(0.31, 0.51), 5);
  });

  it("assigns protein residue and secondary-structure metadata", () => {
    const residues = Array.from({ length: 4 }, (_, index) => ({
      index,
      type_id: null,
      name: "ALA",
      category: "amino-acid" as const,
      chain_id: "A",
      sequence_number: index + 1,
      secondary_structure: index < 3 ? "helix" as const : "coil" as const,
    }));
    const atomicNumbers: number[] = [];
    const atomNames: string[] = [];
    const atomResidueIndex: number[] = [];
    const positions: number[] = [];
    const bonds: Array<[number, number]> = [];
    for (let residue = 0; residue < 4; residue += 1) {
      const start = atomicNumbers.length;
      atomicNumbers.push(7, 6, 6, 8);
      atomNames.push("N", "CA", "C", "O");
      atomResidueIndex.push(residue, residue, residue, residue);
      positions.push(
        residue * 3, 0, 0,
        residue * 3 + 1, 0.6, 0,
        residue * 3 + 2, 0, 0,
        residue * 3 + 2.2, -0.8, 0,
      );
      bonds.push([start, start + 1], [start + 1, start + 2], [start + 2, start + 3]);
      if (residue > 0) bonds.push([start - 2, start]);
    }
    const source: Manifest = {
      schema_version: 1,
      name: "protein",
      frame_count: 1,
      topology: {
        atom_count: atomicNumbers.length,
        atomic_numbers: atomicNumbers,
        atom_names: atomNames,
        atom_residue_index: atomResidueIndex,
        residues,
        bonds,
        bond_source: "topology",
      },
    };
    const scene = prepareScene(source, frame(positions), {
      ...presentation,
      mode: "ribbon",
      wrap: "molecule",
    })!;
    const plan = buildDmolScenePlan(source, scene, {
      ...presentation,
      mode: "ribbon",
    });

    expect(plan.atoms[0]).toMatchObject({ chain: "A", resi: 1, resn: "ALA", ss: "h" });
    expect(plan.atoms.at(-1)).toMatchObject({ chain: "A", resi: 4, ss: "c" });
  });
});

function frame(
  positions: number[],
  cell?: number[],
  pbc: boolean[] = [false, false, false],
): FrameData {
  const arrays = new Map<string, Float32Array | Int32Array>([
    ["positions", new Float32Array(positions)],
  ]);
  if (cell) arrays.set("cell", new Float32Array(cell));
  return { header: { arrays: [], pbc }, arrays };
}

function manifest(
  atomicNumbers: number[],
  bonds: Array<[number, number]> = [],
): Manifest {
  const symbols: Record<number, string> = { 1: "H", 6: "C", 7: "N", 8: "O" };
  return {
    schema_version: 1,
    name: "test",
    frame_count: 1,
    topology: {
      atom_count: atomicNumbers.length,
      atomic_numbers: atomicNumbers,
      symbols: atomicNumbers.map((number) => symbols[number] ?? "X"),
      bonds,
      bond_source: "topology",
    },
  };
}
