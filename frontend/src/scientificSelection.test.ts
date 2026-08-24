import { describe, expect, it } from "vitest";
import {
  atomicNumberForElement,
  cloneNamedSelection,
  createNamedSelection,
  createSelectionTopology,
  ELEMENT_NAMES,
  ELEMENT_SYMBOLS,
  hillFormula,
  mergeSelections,
  parseAtomJumpCommand,
  parseWithinSelectionCommand,
  replaceSelections,
  SelectionIndex,
} from "./scientificSelection";
import type { SceneSelectionContext } from "./scientificSelection";
import type { AtomSelection } from "./types";

const cubicCell = new Float64Array([
  10, 0, 0,
  0, 10, 0,
  0, 0, 10,
]);

function context({
  atomicNumbers,
  positions,
  bonds = [],
  waterAtoms = new Set<number>(),
  instanceToAtom,
  instanceImages,
  baseImages,
  atomResidueIndex,
  cell = cubicCell,
}: {
  atomicNumbers: number[];
  positions: number[];
  bonds?: Array<[number, number]>;
  waterAtoms?: Set<number>;
  instanceToAtom?: number[];
  instanceImages?: number[];
  baseImages?: number[];
  atomResidueIndex?: number[];
  cell?: Float64Array | null;
}): SceneSelectionContext {
  const count = atomicNumbers.length;
  const instances = instanceToAtom ?? Array.from({ length: count }, (_, atom) => atom);
  return {
    count,
    atomicNumbers: Uint8Array.from(atomicNumbers),
    positions: Float64Array.from(positions),
    cell,
    bonds,
    waterAtoms,
    instanceToAtom: Uint32Array.from(instances),
    instanceImages: Int8Array.from(instanceImages ?? instances.flatMap(() => [0, 0, 0])),
    baseImages: Int32Array.from(baseImages ?? Array(count * 3).fill(0)),
    atomResidueIndex: atomResidueIndex ? Int32Array.from(atomResidueIndex) : undefined,
  };
}

describe("exact selection sets", () => {
  const primary: AtomSelection = { atom: 2, image: [200, -150, 0] };
  const replica: AtomSelection = { atom: 2, image: [201, -150, 0] };

  it("deduplicates exact keys without collapsing periodic replicas", () => {
    expect(replaceSelections([primary, replica, primary])).toEqual([primary, replica]);
    expect(mergeSelections([primary], [replica], "add")).toEqual([primary, replica]);
    expect(mergeSelections([primary, replica], [replica], "toggle")).toEqual([primary]);
  });

  it("defensively copies input image offsets", () => {
    const source: AtomSelection = { atom: 1, image: [4, 5, 6] };
    const result = replaceSelections([source]);
    source.image[0] = 99;

    expect(result).toEqual([{ atom: 1, image: [4, 5, 6] }]);
  });
});

describe("canonical periodic images", () => {
  it("combines Int32 base images with Int8 display offsets", () => {
    const source = context({
      atomicNumbers: [6, 8],
      positions: [1, 2, 3, 4, 5, 6],
      instanceToAtom: [0, 1],
      instanceImages: [2, -2, 1, -1, 1, 0],
      baseImages: [200, -150, 4, -300, 190, -8],
    });
    const index = new SelectionIndex(source);

    expect(index.selectionAt(0)).toEqual({ atom: 0, image: [202, -152, 5] });
    expect(index.selectionAt(1)).toEqual({ atom: 1, image: [-301, 191, -8] });
    expect(index.displayedPosition({ atom: 0, image: [202, -152, 5] })).toEqual([
      21, -18, 13,
    ]);
  });

  it("maps every scope member through the anchor display-image offset", () => {
    const source = context({
      atomicNumbers: [8, 1, 1],
      positions: [0, 0, 0, 1, 0, 0, -1, 0, 0],
      bonds: [[0, 1], [0, 2]],
      atomResidueIndex: [7, 7, 7],
      baseImages: [200, 0, 0, -50, 0, 0, 17, 0, 0],
      instanceImages: [2, 0, 0, 2, 0, 0, 2, 0, 0],
    });
    const index = new SelectionIndex(source);

    expect(index.selectScope({ atom: 0, image: [202, 0, 0] }, "residue")).toEqual([
      { atom: 0, image: [202, 0, 0] },
      { atom: 1, image: [-48, 0, 0] },
      { atom: 2, image: [19, 0, 0] },
    ]);
  });
});

describe("scientific scopes", () => {
  const source = context({
    atomicNumbers: [8, 1, 1, 6, 6, 7],
    positions: [
      0, 0, 0,
      1, 0, 0,
      -1, 0, 0,
      5, 0, 0,
      6, 0, 0,
      12, 0, 0,
    ],
    bonds: [[0, 1], [0, 2], [3, 4]],
    waterAtoms: new Set([0, 1, 2]),
    atomResidueIndex: [3, 3, 3, -1, -1, -1],
  });
  const index = new SelectionIndex(source);

  it("selects atom, element, semantic molecule, residue, and strict component scopes", () => {
    const oxygen = { atom: 0, image: [0, 0, 0] } as AtomSelection;
    expect(index.selectScope(oxygen, "atom")).toEqual([oxygen]);
    expect(index.selectScope(oxygen, "element")).toEqual([oxygen]);
    expect(index.selectScope(oxygen, "residue")?.map(({ atom }) => atom)).toEqual([0, 1, 2]);
    expect(index.selectScope(oxygen, "molecule")?.map(({ atom }) => atom)).toEqual([0, 1, 2]);
    expect(index.selectScope(oxygen, "component")?.map(({ atom }) => atom)).toEqual([0, 1, 2]);

    const carbon = { atom: 3, image: [0, 0, 0] } as AtomSelection;
    expect(index.selectScope(carbon, "residue")).toBeNull();
    expect(index.selectScope(carbon, "molecule")?.map(({ atom }) => atom)).toEqual([3, 4]);
    expect(index.selectScope(carbon, "component")?.map(({ atom }) => atom)).toEqual([3, 4]);
  });

  it("selects elements and water over visible instances in instance order", () => {
    expect(index.selectElement("oxygen")).toEqual([{ atom: 0, image: [0, 0, 0] }]);
    expect(index.selectElement("O")).toEqual([{ atom: 0, image: [0, 0, 0] }]);
    expect(index.selectWater().map(({ atom }) => atom)).toEqual([0, 1, 2]);
  });

  it("distinguishes a bonded molecule from one residue", () => {
    const protein = new SelectionIndex(context({
      atomicNumbers: [7, 6, 6, 8],
      positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0],
      bonds: [[0, 1], [1, 2], [2, 3]],
      atomResidueIndex: [0, 0, 1, 1],
    }));
    const anchor = { atom: 0, image: [0, 0, 0] } as AtomSelection;

    expect(protein.selectScope(anchor, "residue")?.map(({ atom }) => atom)).toEqual([0, 1]);
    expect(protein.selectScope(anchor, "molecule")?.map(({ atom }) => atom)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(protein.selectScope(anchor, "component")?.map(({ atom }) => atom)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("reports connectivity and residue scopes as unavailable instead of inferring them", () => {
    const unconnected = new SelectionIndex(context({
      atomicNumbers: [6, 6],
      positions: [0, 0, 0, 1.2, 0, 0],
    }));
    const anchor = { atom: 0, image: [0, 0, 0] } as AtomSelection;

    expect(unconnected.selectScope(anchor, "component")).toBeNull();
    expect(unconnected.selectScope(anchor, "molecule")).toBeNull();
    expect(unconnected.selectScope(anchor, "residue")).toBeNull();
  });
});

describe("spatial selection and summaries", () => {
  it("selects one-anchor neighbors in displayed Cartesian space", () => {
    const source = context({
      atomicNumbers: [6, 8, 1],
      positions: [0, 0, 0, 1.5, 0, 0, 4, 0, 0],
      instanceToAtom: [0, 1, 2, 0],
      instanceImages: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
      baseImages: [200, 0, 0, -20, 0, 0, 0, 0, 0],
    });
    const index = new SelectionIndex(source);

    expect(index.withinDistance({ atom: 0, image: [200, 0, 0] }, 2).map(
      ({ atom, image }) => [atom, image],
    )).toEqual([
      [0, [200, 0, 0]],
      [1, [-20, 0, 0]],
    ]);
    expect(index.withinDistance({ atom: 0, image: [201, 0, 0] }, 0.1)).toEqual([
      { atom: 0, image: [201, 0, 0] },
    ]);
  });

  it("selects the union around every selected atom", () => {
    const index = new SelectionIndex(context({
      atomicNumbers: [6, 1, 8, 1, 7],
      positions: [
        0, 0, 0,
        0.8, 0, 0,
        10, 0, 0,
        10.8, 0, 0,
        5, 0, 0,
      ],
    }));

    expect(index.withinDistanceOf([
      { atom: 0, image: [0, 0, 0] },
      { atom: 2, image: [0, 0, 0] },
    ], 1).map(({ atom }) => atom)).toEqual([0, 1, 2, 3]);
  });

  it("uses Hill notation and reports centroid and extent", () => {
    const source = context({
      atomicNumbers: [6, 1, 1, 8],
      positions: [
        0, 0, 0,
        1, 0, 0,
        0, 2, 0,
        0, 0, 3,
      ],
    });
    const index = new SelectionIndex(source);
    const selections = [0, 1, 2, 3].map((atom) => ({
      atom,
      image: [0, 0, 0] as [number, number, number],
    }));

    expect(index.summarize(selections)).toEqual({
      count: 4,
      formula: "CH2O",
      centroid: [0.25, 0.5, 0.75],
      extent: [1, 2, 3],
    });
    expect(hillFormula([8, 1, 1])).toBe("H2O");
    expect(hillFormula([8, 6, 1, 6, 1, 1, 1, 1, 1])).toBe("C2H6O");
  });

  it("keeps periodic occurrences out of the chemical formula", () => {
    const index = new SelectionIndex(context({
      atomicNumbers: [1],
      positions: [0, 0, 0],
    }));

    expect(index.summarize([
      { atom: 0, image: [0, 0, 0] },
      { atom: 0, image: [1, 0, 0] },
    ])).toEqual({
      count: 2,
      formula: "H",
      centroid: [5, 0, 0],
      extent: [10, 0, 0],
    });
  });
});

describe("element and command language", () => {
  it("covers every element symbol and common English name", () => {
    expect(ELEMENT_SYMBOLS).toHaveLength(119);
    expect(ELEMENT_NAMES).toHaveLength(119);
    expect(atomicNumberForElement("oxygen")).toBe(8);
    expect(atomicNumberForElement("Og")).toBe(118);
    expect(atomicNumberForElement("aluminum")).toBe(13);
    expect(atomicNumberForElement("cesium")).toBe(55);
    expect(atomicNumberForElement("not-an-element")).toBeNull();
  });

  it("parses only a complete positive within-selection command", () => {
    expect(parseWithinSelectionCommand("select within 3 A of selection")).toBe(3);
    expect(parseWithinSelectionCommand(" Select within .5 Å of selection ")).toBe(0.5);
    expect(parseWithinSelectionCommand("select within 2.5 angstroms of selection")).toBe(2.5);
    expect(parseWithinSelectionCommand("select within 1e-2 angstrom of selection")).toBe(0.01);

    for (const invalid of [
      "select within 0 A of selection",
      "select within -1 A of selection",
      "select within 3 nm of selection",
      "select within 3 A",
      "please select within 3 A of selection",
      "select within Infinity A of selection",
    ]) {
      expect(parseWithinSelectionCommand(invalid)).toBeNull();
    }
  });

  it("jumps to a 1-based atom index or matching atom label", () => {
    const options = {
      atomCount: 3,
      symbolAt: (index: number) => ["O", "H", "H"][index],
      atomNames: ["O1", "H1", "H2"],
    };
    expect(parseAtomJumpCommand("1", options)).toBe(0);
    expect(parseAtomJumpCommand("#2", options)).toBe(1);
    expect(parseAtomJumpCommand("atom 3", options)).toBe(2);
    expect(parseAtomJumpCommand("O1", options)).toBe(0);
    expect(parseAtomJumpCommand("H2", options)).toBe(1);
    expect(parseAtomJumpCommand("H1", options)).toBe(1);
    expect(parseAtomJumpCommand("0", options)).toBeNull();
    expect(parseAtomJumpCommand("4", options)).toBeNull();
    expect(parseAtomJumpCommand("C1", options)).toBeNull();
  });
});

describe("named selections", () => {
  it("normalizes names and defensively copies on creation and cloning", () => {
    const source: AtomSelection[] = [{ atom: 4, image: [140, -130, 2] }];
    const named = createNamedSelection("  active   site  ", source);
    const cloned = cloneNamedSelection(named);
    source[0].image[0] = 0;
    named.selections[0].image[1] = 0;

    expect(named.name).toBe("active site");
    expect(cloned).toEqual({
      name: "active site",
      selections: [{ atom: 4, image: [140, -130, 2] }],
    });
    expect(() => createNamedSelection("  ", [])).toThrow("requires a name");
  });
});

describe("large selection index", () => {
  it("indexes and queries 100k visible instances without pairwise selection scans", () => {
    const count = 100_000;
    const atomicNumbers = new Uint8Array(count);
    const positions = new Float32Array(count * 3);
    const baseImages = new Int32Array(count * 3);
    const instanceToAtom = new Uint32Array(count);
    const instanceImages = new Int8Array(count * 3);
    const bonds: Array<[number, number]> = [];
    for (let atom = 0; atom < count; atom += 1) {
      atomicNumbers[atom] = atom % 2 === 0 ? 8 : 1;
      positions[atom * 3] = atom;
      instanceToAtom[atom] = atom;
      if (atom + 1 < count) bonds.push([atom, atom + 1]);
    }
    const source: SceneSelectionContext = {
      count,
      atomicNumbers,
      positions,
      cell: cubicCell,
      bonds,
      waterAtoms: new Set(),
      instanceToAtom,
      instanceImages,
      baseImages,
    };
    const topology = createSelectionTopology(source);
    const index = new SelectionIndex(source, topology);
    const anchor = { atom: 50_000, image: [0, 0, 0] } as AtomSelection;

    expect(index.selectElement("O")).toHaveLength(50_000);
    expect(index.withinDistance(anchor, 1.01).map(({ atom }) => atom)).toEqual([
      49_999,
      50_000,
      50_001,
    ]);
    expect(index.selectScope(anchor, "component")).toHaveLength(count);

    const started = performance.now();
    for (let iteration = 0; iteration < 100; iteration += 1) {
      new SelectionIndex(source, topology);
    }
    expect(performance.now() - started).toBeLessThan(250);
  }, 10_000);
});
