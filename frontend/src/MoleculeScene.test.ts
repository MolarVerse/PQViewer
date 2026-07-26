import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  alignedTrailSegments,
  atomSelectionForInstance,
  centeredFramePositions,
  clearOrbitMotion,
  isAdditivePick,
  nextKeyboardAtomCursor,
  nextKeyboardAtomSelection,
  periodicBondSegments,
  sceneCapabilities,
  selectionMarkerState,
  selectedDisplayedPosition,
  updateSelectionMarkers,
} from "./MoleculeScene";
import type { SelectionRenderState } from "./MoleculeScene";
import {
  activeVectorInstances,
  backboneResidues,
  cellImageCorners,
  createCellBasis,
  detectWaterAtoms,
  displayedBaseImages,
  fractionalStructureCenter,
  frameGeometryLayout,
  imageLayoutShape,
  includeCellInFit,
  MAX_ATOM_INSTANCES,
  MAX_BOND_INSTANCES,
  MAX_FORCE_VECTORS,
  MAX_HIGH_DETAIL_INSTANCES,
  MAX_INFERRED_BOND_CANDIDATES,
  MAX_SPHERE_INSTANCES,
  minimumImageBondShift,
  periodicImageOffsets,
  prepareFrameGeometry,
  prepareScene,
  publicationBondGeometry,
  representationRadius,
  sameFrameGeometryLayout,
  transformDisplayVector,
  usesHighDetailGeometry,
  usesPointAtoms,
} from "./scene/model";
import type { PreparedScene } from "./scene/model";
import type { CellOffset, FrameData, Manifest, ScenePresentation } from "./types";

const triclinicCell = new Float32Array([
  4, 0, 0,
  1, 3, 0,
  0.5, 0.25, 2.5,
]);

function cellBasis(cell: Float32Array) {
  const a = new THREE.Vector3(cell[0], cell[1], cell[2]);
  const b = new THREE.Vector3(cell[3], cell[4], cell[5]);
  const c = new THREE.Vector3(cell[6], cell[7], cell[8]);
  const determinant = a.dot(new THREE.Vector3().crossVectors(b, c));
  const vectors: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [a, b, c];
  const reciprocal: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3().crossVectors(b, c).multiplyScalar(1 / determinant),
    new THREE.Vector3().crossVectors(c, a).multiplyScalar(1 / determinant),
    new THREE.Vector3().crossVectors(a, b).multiplyScalar(1 / determinant),
  ];
  return { vectors, reciprocal };
}

function toCartesian(fractional: [number, number, number], cell = triclinicCell): THREE.Vector3 {
  const basis = cellBasis(cell);
  return new THREE.Vector3()
    .addScaledVector(basis.vectors[0], fractional[0])
    .addScaledVector(basis.vectors[1], fractional[1])
    .addScaledVector(basis.vectors[2], fractional[2]);
}

function toFractional(point: THREE.Vector3, cell = triclinicCell): THREE.Vector3 {
  const basis = cellBasis(cell);
  return new THREE.Vector3(
    point.dot(basis.reciprocal[0]),
    point.dot(basis.reciprocal[1]),
    point.dot(basis.reciprocal[2]),
  );
}

function expectVectorClose(actual: THREE.Vector3, expected: THREE.Vector3): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.z).toBeCloseTo(expected.z, 6);
}

const basePresentation: ScenePresentation = {
  mode: "ball-stick",
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
  quality: "auto",
};

describe("selection pointer intent", () => {
  const intent = (
    pointerType: string,
    modifiers: Partial<Pick<PointerEvent, "shiftKey" | "metaKey" | "ctrlKey">> = {},
  ) => ({
    pointerType,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...modifiers,
  });

  it("keeps an unmodified mouse click as replacement selection", () => {
    expect(isAdditivePick(intent("mouse"))).toBe(false);
  });

  it("keeps desktop modifier clicks additive", () => {
    expect(isAdditivePick(intent("mouse", { shiftKey: true }))).toBe(true);
    expect(isAdditivePick(intent("mouse", { metaKey: true }))).toBe(true);
    expect(isAdditivePick(intent("mouse", { ctrlKey: true }))).toBe(true);
  });

  it("makes touch and pen taps additive without a modifier", () => {
    expect(isAdditivePick(intent("touch"))).toBe(true);
    expect(isAdditivePick(intent("pen"))).toBe(true);
  });
});

describe("selection marker scaling", () => {
  it("switches large selections to one reusable point buffer without retaining rings", () => {
    expect(selectionMarkerState(512, 100_000, null)).toEqual({
      mode: "rings",
      pointCapacity: 0,
      reusePointBuffer: false,
      clearRingMarkers: false,
    });
    expect(selectionMarkerState(513, 100_000, null)).toEqual({
      mode: "points",
      pointCapacity: 513,
      reusePointBuffer: false,
      clearRingMarkers: true,
    });

    const initial = selectionMarkerState(100_000, 100_000, null);
    expect(initial).toEqual({
      mode: "points",
      pointCapacity: 100_000,
      reusePointBuffer: false,
      clearRingMarkers: true,
    });
    expect(selectionMarkerState(100_000, 100_000, initial.pointCapacity)).toEqual({
      ...initial,
      reusePointBuffer: true,
    });
    expect(selectionMarkerState(100_000, 100_000, 99_999).reusePointBuffer).toBe(false);
  });

  it("keeps 100k marker-state updates bounded", () => {
    const started = performance.now();
    let state = selectionMarkerState(0, 100_000, null);
    for (let selected = 1; selected <= 100_000; selected += 1) {
      state = selectionMarkerState(selected, 100_000, state.pointCapacity || null);
    }

    expect(state.mode).toBe("points");
    expect(state.pointCapacity).toBe(100_000);
    expect(state.clearRingMarkers).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  }, 1_000);

  it("renders 100k selections through one reused point buffer", () => {
    const count = 100_000;
    const positions = new Float32Array(count * 3);
    const instanceToAtom = new Uint32Array(count);
    for (let atom = 0; atom < count; atom += 1) {
      positions[atom * 3] = atom % 1_000;
      positions[atom * 3 + 1] = Math.floor(atom / 1_000);
      instanceToAtom[atom] = atom;
    }
    const model: PreparedScene = {
      count,
      atomicNumbers: Array(count).fill(6),
      positions,
      baseImages: new Int32Array(count * 3),
      basis: null,
      cellCenter: new THREE.Vector3(),
      displayTransform: new THREE.Matrix3(),
      pbc: [false, false, false],
      bonds: [],
      waterAtoms: new Set(),
      visibleAtoms: Array.from(instanceToAtom),
      images: [[0, 0, 0]],
      instanceToAtom,
      instanceImages: new Int8Array(count * 3),
      radii: Array(count).fill(0.3),
      backbone: [],
    };
    const selectionGeometry = new THREE.RingGeometry(1, 1.2, 12);
    const selectionMaterial = new THREE.MeshBasicMaterial();
    const pointGeometry = new THREE.BufferGeometry();
    const pointMaterial = new THREE.PointsMaterial();
    const state: SelectionRenderState = {
      selection: new THREE.Group(),
      selectionGeometry,
      selectionMaterial,
      selectionPoints: new THREE.Points(pointGeometry, pointMaterial),
      instanceToAtom,
      instanceImages: model.instanceImages,
      baseImages: model.baseImages,
      model,
    };
    const selections = Array.from({ length: count }, (_, atom) => ({
      atom,
      image: [0, 0, 0] as [number, number, number],
    }));

    updateSelectionMarkers(state, selections.slice(0, 2), false);
    expect(state.selection.children).toHaveLength(2);
    expect(state.selectionPoints.visible).toBe(false);

    const started = performance.now();
    updateSelectionMarkers(state, selections, false);
    const firstAttribute = pointGeometry.getAttribute("position");
    expect(state.selection.children).toHaveLength(0);
    expect(state.selectionPoints.visible).toBe(true);
    expect(pointGeometry.drawRange.count).toBe(count);
    expect(firstAttribute.count).toBe(count);

    updateSelectionMarkers(state, selections, false);
    expect(pointGeometry.getAttribute("position")).toBe(firstAttribute);
    expect(pointGeometry.drawRange.count).toBe(count);
    expect(performance.now() - started).toBeLessThan(3_000);

    pointGeometry.dispose();
    pointMaterial.dispose();
    selectionGeometry.dispose();
    selectionMaterial.dispose();
  }, 5_000);
});

describe("keyboard atom navigation", () => {
  const atoms = new Uint32Array([2, 4, 2, 7]);
  const images = new Int8Array([
    0, 0, 0,
    0, 0, 0,
    1, 0, 0,
    0, 0, 0,
  ]);

  it("cycles through every visible atom image", () => {
    expect(nextKeyboardAtomSelection(atoms, images, null, 0)).toEqual({
      atom: 2,
      image: [0, 0, 0],
    });
    expect(nextKeyboardAtomSelection(
      atoms,
      images,
      { atom: 2, image: [0, 0, 0] },
      1,
    )).toEqual({ atom: 4, image: [0, 0, 0] });
    expect(nextKeyboardAtomSelection(
      atoms,
      images,
      { atom: 2, image: [1, 0, 0] },
      1,
    )).toEqual({ atom: 7, image: [0, 0, 0] });
    expect(nextKeyboardAtomSelection(
      atoms,
      images,
      { atom: 2, image: [1, 0, 0] },
      -1,
    )).toEqual({ atom: 4, image: [0, 0, 0] });
    expect(nextKeyboardAtomSelection(
      atoms,
      images,
      { atom: 7, image: [0, 0, 0] },
      1,
    )).toEqual({ atom: 2, image: [0, 0, 0] });
  });

  it("continues from a validated instance cursor", () => {
    expect(nextKeyboardAtomCursor(
      atoms,
      images,
      { atom: 2, image: [1, 0, 0] },
      2,
      1,
    )).toEqual({
      selection: { atom: 7, image: [0, 0, 0] },
      instance: 3,
    });
    expect(nextKeyboardAtomCursor(
      atoms,
      images,
      { atom: 2, image: [1, 0, 0] },
      1,
      -1,
    )).toEqual({
      selection: { atom: 4, image: [0, 0, 0] },
      instance: 1,
    });
  });

  it("keeps cursor movement bounded at the render-instance limit", () => {
    const count = 250_000;
    const largeAtoms = new Uint32Array(count);
    for (let index = 0; index < count; index += 1) largeAtoms[index] = index;
    const largeImages = new Int8Array(count * 3);
    let cursor = {
      selection: { atom: 249_900, image: [0, 0, 0] as [number, number, number] },
      instance: 249_900,
    };
    for (let step = 0; step < 200; step += 1) {
      cursor = nextKeyboardAtomCursor(
        largeAtoms,
        largeImages,
        cursor.selection,
        cursor.instance,
        1,
      )!;
    }

    expect(cursor).toEqual({
      selection: { atom: 100, image: [0, 0, 0] },
      instance: 100,
    });
  });

  it("uses the traversal edge when the current atom is stale", () => {
    const stale = { atom: 9, image: [0, 0, 0] as [number, number, number] };
    expect(nextKeyboardAtomSelection(atoms, images, stale, 1)).toEqual({
      atom: 2,
      image: [0, 0, 0],
    });
    expect(nextKeyboardAtomSelection(atoms, images, stale, -1)).toEqual({
      atom: 7,
      image: [0, 0, 0],
    });
  });

  it("ignores malformed image mappings", () => {
    expect(nextKeyboardAtomSelection(
      new Uint32Array([3]),
      new Int8Array([1, 0, 0]),
      null,
      0,
    )).toEqual({ atom: 3, image: [1, 0, 0] });
    expect(nextKeyboardAtomSelection(
      new Uint32Array([3]),
      new Int8Array([0, 0]),
      null,
      0,
    )).toBeNull();
  });
});

function frame(positions: number[], cell?: number[], pbc: boolean[] = [false, false, false]): FrameData {
  const arrays = new Map<string, Float32Array | Int32Array>([["positions", new Float32Array(positions)]]);
  if (cell) arrays.set("cell", new Float32Array(cell));
  return { header: { arrays: [], pbc }, arrays };
}

function manifest(
  atomicNumbers: number[],
  bonds: Array<[number, number]> = [],
): Manifest {
  return {
    schema_version: 1,
    name: "test",
    frame_count: 1,
    topology: {
      atom_count: atomicNumbers.length,
      atomic_numbers: atomicNumbers,
      symbols: atomicNumbers.map((number) => ({ 1: "H", 6: "C", 7: "N", 8: "O" })[number] ?? "X"),
      bonds,
      bond_source: "topology",
    },
  };
}

describe("periodic geometry", () => {
  it("keeps the picked periodic image with the base atom", () => {
    const selection = atomSelectionForInstance(
      new Uint32Array([4, 4]),
      new Int8Array([0, 0, 0, 1, -1, 0]),
      1,
    );

    expect(selection).toEqual({ atom: 4, image: [1, -1, 0] });
    expect(atomSelectionForInstance(new Uint32Array([4]), new Int8Array([0, 0]), 0)).toBeNull();
  });

  it("keeps physical image identity across display wrapping", () => {
    const cell = new Float32Array([
      10, 0, 0,
      0, 10, 0,
      0, 0, 10,
    ]);
    const basis = createCellBasis(cell)!;
    const source = new Float32Array([12, 0, 0]);
    const wrapped = new Float32Array([2, 0, 0]);
    const baseImages = displayedBaseImages(
      source,
      wrapped,
      1,
      basis,
      [true, true, true],
    );

    expect([...baseImages]).toEqual([-1, 0, 0]);
    expect(atomSelectionForInstance(
      new Uint32Array([0]),
      new Int8Array([0, 0, 0]),
      0,
      baseImages,
    )).toEqual({ atom: 0, image: [-1, 0, 0] });
    expect(atomSelectionForInstance(
      new Uint32Array([0]),
      new Int8Array([-1, 0, 0]),
      0,
    )).toEqual({ atom: 0, image: [-1, 0, 0] });
  });

  it("stores canonical image shifts beyond display-offset integer limits", () => {
    const cell = new Float32Array([
      10, 0, 0,
      0, 10, 0,
      0, 0, 10,
    ]);
    const baseImages = displayedBaseImages(
      new Float32Array([1302, 0, 0]),
      new Float32Array([2, 0, 0]),
      1,
      createCellBasis(cell),
      [true, true, true],
    );

    expect(baseImages).toBeInstanceOf(Int32Array);
    expect([...baseImages]).toEqual([-130, 0, 0]);
  });

  it("wraps triclinic fractional coordinates into [-0.5, 0.5)", () => {
    const sourceFractions: Array<[number, number, number]> = [
      [0.6, -0.6, 1.51],
      [-1.49, 0.51, 0.49],
    ];
    const positions = new Float32Array(sourceFractions.flatMap((value) => toCartesian(value).toArray()));
    const frame: FrameData = {
      header: { arrays: [], pbc: [true, true, true] },
      arrays: new Map([
        ["positions", positions],
        ["cell", triclinicCell],
      ]),
    };

    const wrapped = centeredFramePositions(frame, sourceFractions.length);
    expect(wrapped).not.toBeNull();

    const expectedFractions: Array<[number, number, number]> = [
      [-0.4, 0.4, -0.49],
      [-0.49, -0.49, 0.49],
    ];
    expectedFractions.forEach((expected, index) => {
      const actualPoint = new THREE.Vector3().fromArray(wrapped!, index * 3);
      const actualFraction = toFractional(actualPoint);
      expectVectorClose(actualFraction, new THREE.Vector3(...expected));
      expect(actualFraction.x).toBeGreaterThanOrEqual(-0.5);
      expect(actualFraction.x).toBeLessThan(0.5);
      expect(actualFraction.y).toBeGreaterThanOrEqual(-0.5);
      expect(actualFraction.y).toBeLessThan(0.5);
      expect(actualFraction.z).toBeGreaterThanOrEqual(-0.5);
      expect(actualFraction.z).toBeLessThan(0.5);
    });
  });

  it("preserves a rounded coordinate just below the centered boundary", () => {
    const cell = new Float32Array([
      10.003, 0.00001, 0.00006,
      0.00016, 9.087, 0.00037,
      0.00048, 0.00058, 11.129,
    ]);
    const source = new Float32Array(toCartesian([0.5, 0, 0], cell).toArray());
    const sourceFraction = toFractional(new THREE.Vector3().fromArray(source), cell);
    expect(sourceFraction.x).toBeLessThan(0.5);
    expect(sourceFraction.x).toBeGreaterThan(0.5 - 1e-10);

    const frame: FrameData = {
      header: { arrays: [], pbc: [true, true, true] },
      arrays: new Map([
        ["positions", source],
        ["cell", cell],
      ]),
    };
    const wrapped = centeredFramePositions(frame, 1)!;
    const wrappedFraction = toFractional(new THREE.Vector3().fromArray(wrapped), cell);
    const baseImages = displayedBaseImages(
      source,
      wrapped,
      1,
      createCellBasis(cell),
      [true, true, true],
    );

    expect(wrappedFraction.x).toBeCloseTo(0.5, 6);
    expect(wrappedFraction.y).toBeCloseTo(0, 6);
    expect(wrappedFraction.z).toBeCloseTo(0, 6);
    expect([...baseImages]).toEqual([0, 0, 0]);
  });

  it("splits a minimum-image bond at the centered cell boundary", () => {
    const start: [number, number, number] = [0.45, 0.2, 0.1];
    const end: [number, number, number] = [-0.45, 0.22, 0.08];
    const positions = new Float32Array([
      ...toCartesian(start).toArray(),
      ...toCartesian(end).toArray(),
    ]);

    const segments = periodicBondSegments(positions, 0, 1, cellBasis(triclinicCell), [true, true, true]);

    expect(segments).toHaveLength(2);
    expect(toFractional(segments[0].to).x).toBeCloseTo(0.5, 6);
    expect(toFractional(segments[1].from).x).toBeCloseTo(-0.5, 6);

    const minimumImageDelta = toCartesian([0.1, 0.02, -0.02]);
    const totalLength = segments.reduce((sum, segment) => sum + segment.from.distanceTo(segment.to), 0);
    const directLength = new THREE.Vector3().fromArray(positions, 0)
      .distanceTo(new THREE.Vector3().fromArray(positions, 3));
    expect(totalLength).toBeCloseTo(minimumImageDelta.length(), 6);
    expect(totalLength).toBeLessThan(directLength / 5);
    segments.flatMap((segment) => [segment.from, segment.to]).forEach((point) => {
      const fractional = toFractional(point);
      expect(fractional.x).toBeGreaterThanOrEqual(-0.5 - 1e-6);
      expect(fractional.x).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(fractional.y).toBeGreaterThanOrEqual(-0.5 - 1e-6);
      expect(fractional.y).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(fractional.z).toBeGreaterThanOrEqual(-0.5 - 1e-6);
      expect(fractional.z).toBeLessThanOrEqual(0.5 + 1e-6);
    });
  });

  it("completes publication bonds with neighbor-image context", () => {
    const positions = [
      ...toCartesian([0.45, 0.2, 0.1]).toArray(),
      ...toCartesian([-0.45, 0.22, 0.08]).toArray(),
    ];
    const scene = prepareScene(
      manifest([6, 6], [[0, 1]]),
      frame(positions, [...triclinicCell], [true, true, true]),
      basePresentation,
    )!;

    expect(minimumImageBondShift(scene.positions, 0, 1, scene.basis, scene.pbc)).toEqual([1, 0, 0]);

    const interactive = publicationBondGeometry(scene, basePresentation, false);
    expect(interactive.segments).toHaveLength(2);
    expect(interactive.segments.every((segment) => !segment.context)).toBe(true);
    expect(interactive.contextAtoms).toEqual([]);

    const publication = publicationBondGeometry(scene, basePresentation, true);
    expect(publication.segments).toHaveLength(2);
    expect(publication.segments.every((segment) => segment.context)).toBe(true);
    publication.segments.forEach((segment) => {
      expect(segment.from.distanceTo(segment.to)).toBeCloseTo(toCartesian([0.1, 0.02, -0.02]).length(), 6);
    });
    expect(publication.contextAtoms).toHaveLength(2);
    expect(publication.contextAtoms.map(({ atomIndex, image }) => ({ atomIndex, image }))).toEqual([
      { atomIndex: 1, image: [1, 0, 0] },
      { atomIndex: 0, image: [-1, 0, 0] },
    ]);
    expect(toFractional(publication.contextAtoms[0].position).x).toBeCloseTo(0.55, 6);
    expect(toFractional(publication.contextAtoms[1].position).x).toBeCloseTo(-0.55, 6);
  });

  it("deduplicates periodic context atoms across bonds and included images", () => {
    const presentation: ScenePresentation = {
      ...basePresentation,
      images: { min: [0, 0, 0], max: [1, 0, 0] },
    };
    const positions = [
      ...toCartesian([0.44, 0.18, 0.1]).toArray(),
      ...toCartesian([0.46, 0.26, 0.08]).toArray(),
      ...toCartesian([-0.45, 0.22, 0.09]).toArray(),
    ];
    const scene = prepareScene(
      manifest([6, 6, 6], [[0, 2], [1, 2]]),
      frame(positions, [...triclinicCell], [true, true, true]),
      presentation,
    )!;

    const geometry = publicationBondGeometry(scene, presentation, true);
    expect(scene.images).toEqual([[0, 0, 0], [1, 0, 0]]);
    expect(geometry.segments).toHaveLength(6);
    expect(geometry.segments.filter((segment) => segment.context)).toHaveLength(4);
    expect(geometry.segments.every((segment) => segment.from.distanceTo(segment.to) < 1)).toBe(true);
    expect(geometry.contextAtoms).toHaveLength(3);
    expect(geometry.contextAtoms.map(({ atomIndex, image }) => ({ atomIndex, image }))).toEqual([
      { atomIndex: 0, image: [-1, 0, 0] },
      { atomIndex: 1, image: [-1, 0, 0] },
      { atomIndex: 2, image: [2, 0, 0] },
    ]);
  });

  it("omits publication bonds for representations without bonds", () => {
    const scene = prepareScene(
      manifest([6, 6], [[0, 1]]),
      frame([0, 0, 0, 1.4, 0, 0]),
      basePresentation,
    )!;
    expect(publicationBondGeometry(scene, basePresentation, true)).toMatchObject({
      segments: [{ context: false }],
      contextAtoms: [],
    });
    for (const mode of ["spacefill", "ribbon"] as const) {
      expect(publicationBondGeometry(scene, { ...basePresentation, mode }, true)).toEqual({
        segments: [],
        contextAtoms: [],
      });
    }
  });

  it("finds the exact minimum image in an unreduced triclinic cell", () => {
    const cell = new Float32Array([
      1, 0, 0,
      10, 1, 0,
      0, 0, 5,
    ]);
    const positions = new Float32Array([
      0, 0, 0,
      ...toCartesian([0, 0.49, 0], cell).toArray(),
    ]);
    const segments = periodicBondSegments(positions, 0, 1, cellBasis(cell), [true, true, false]);
    const totalLength = segments.reduce((sum, segment) => sum + segment.from.distanceTo(segment.to), 0);

    expect(totalLength).toBeCloseTo(Math.hypot(0.1, 0.49), 6);
    expect(segments.length).toBeGreaterThan(2);
    expect(minimumImageBondShift(positions, 0, 1, cellBasis(cell), [true, true, false])).toEqual([-5, 0, 0]);

    const topology = manifest([6, 6]);
    topology.topology.bond_source = "inferred";
    const scene = prepareScene(topology, frame([...positions], [...cell], [true, true, false]), basePresentation);
    expect(scene?.bonds).toEqual([[0, 1]]);
    const publication = publicationBondGeometry(scene!, basePresentation, true);
    expect(publication.segments).toHaveLength(2);
    publication.segments.forEach((segment) => {
      expect(segment.from.distanceTo(segment.to)).toBeCloseTo(Math.hypot(0.1, 0.49), 6);
    });
  });

  it("places the primary triclinic cell at centered fractional limits", () => {
    const basis = createCellBasis(triclinicCell)!;
    const fractions = cellImageCorners(basis, [0, 0, 0]).map((point) => toFractional(point));
    expect(fractions).toHaveLength(8);
    expect(Math.min(...fractions.map((point) => point.x))).toBeCloseTo(-0.5, 6);
    expect(Math.max(...fractions.map((point) => point.x))).toBeCloseTo(0.5, 6);
    expect(Math.min(...fractions.map((point) => point.y))).toBeCloseTo(-0.5, 6);
    expect(Math.max(...fractions.map((point) => point.y))).toBeCloseTo(0.5, 6);
    expect(Math.min(...fractions.map((point) => point.z))).toBeCloseTo(-0.5, 6);
    expect(Math.max(...fractions.map((point) => point.z))).toBeCloseTo(0.5, 6);
  });

  it("uses the exact centered half-open interval", () => {
    const source = frame(
      [5, 0, 0, -5, 0, 0, 15, 0, 0],
      [10, 0, 0, 0, 10, 0, 0, 0, 10],
      [true, true, true],
    );
    const scene = prepareScene(manifest([6, 6, 6]), source, basePresentation)!;

    expect([...scene.positions]).toEqual([
      -5, 0, 0,
      -5, 0, 0,
      -5, 0, 0,
    ]);
    expect([...scene.baseImages]).toEqual([
      -1, 0, 0,
      0, 0, 0,
      -2, 0, 0,
    ]);
  });

  it("consumes exact backend image shifts without mutating source arrays", () => {
    const positions = new Float32Array([
      ...toCartesian([0.5, -0.5, 0.25]).toArray(),
      ...toCartesian([1.5, 0.2, -0.1]).toArray(),
    ]);
    const shifts = new Int32Array([
      -1, 0, 0,
      -2, 0, 0,
    ]);
    const source = frame([...positions], [...triclinicCell], [true, true, true]);
    source.arrays.set("centered_image_shifts", shifts);
    const beforePositions = [...positions];
    const beforeShifts = [...shifts];

    const scene = prepareScene(manifest([6, 6]), source, basePresentation)!;

    expect([...scene.baseImages]).toEqual(beforeShifts);
    expect(toFractional(new THREE.Vector3().fromArray(scene.positions, 0)).x).toBeCloseTo(-0.5, 6);
    expect(toFractional(new THREE.Vector3().fromArray(scene.positions, 3)).x).toBeCloseTo(-0.5, 6);
    expect([...positions]).toEqual(beforePositions);
    expect([...shifts]).toEqual(beforeShifts);
  });

  it("moves the centered cell in fractional coordinates", () => {
    const source = frame(
      [10, 0, 0, 9, 0, 0],
      [10, 0, 0, 0, 8, 0, 0, 0, 6],
      [true, true, true],
    );
    const presentation: ScenePresentation = {
      ...basePresentation,
      cellOrigin: [0.5, 0, 0],
    };
    const scene = prepareScene(manifest([6, 6]), source, presentation)!;
    const corners = cellImageCorners(scene.basis!, [0, 0, 0], scene.cellCenter);

    expect([...scene.positions]).toEqual([0, 0, 0, 9, 0, 0]);
    expect([...scene.baseImages]).toEqual([-1, 0, 0, 0, 0, 0]);
    expect(scene.cellCenter.toArray()).toEqual([5, 0, 0]);
    expect(Math.min(...corners.map((point) => point.x))).toBeCloseTo(0, 7);
    expect(Math.max(...corners.map((point) => point.x))).toBeCloseTo(10, 7);
  });

  it("mirrors the Cartesian scene through the current cell center", () => {
    const origin: CellOffset = [0.2, -0.1, 0.3];
    const positions = new Float32Array([
      ...toCartesian([0.35, -0.2, 0.1]).toArray(),
      ...toCartesian([-0.15, 0.25, 0.4]).toArray(),
    ]);
    const source = frame([...positions], [...triclinicCell], [true, true, true]);
    const normal = prepareScene(manifest([6, 8], [[0, 1]]), source, {
      ...basePresentation,
      cellOrigin: origin,
    })!;
    const mirrored = prepareScene(manifest([6, 8], [[0, 1]]), source, {
      ...basePresentation,
      cellOrigin: origin,
      mirror: [true, false, false],
    })!;
    const center = normal.cellCenter;
    const normalDistance = new THREE.Vector3().fromArray(normal.positions, 0)
      .distanceTo(new THREE.Vector3().fromArray(normal.positions, 3));
    const mirroredDistance = new THREE.Vector3().fromArray(mirrored.positions, 0)
      .distanceTo(new THREE.Vector3().fromArray(mirrored.positions, 3));

    expect(mirrored.cellCenter.toArray()).toEqual(center.toArray());
    expect(mirroredDistance).toBeCloseTo(normalDistance, 6);
    expect(mirrored.displayTransform.determinant()).toBeCloseTo(-1, 12);
    expect([...mirrored.baseImages]).toEqual([...normal.baseImages]);
    for (let left = 0; left < 3; left += 1) {
      for (let right = 0; right < 3; right += 1) {
        expect(mirrored.basis!.vectors[left].dot(mirrored.basis!.vectors[right]))
          .toBeCloseTo(normal.basis!.vectors[left].dot(normal.basis!.vectors[right]), 6);
      }
    }

    const vector = new THREE.Vector3(0.4, -1.2, 2.1);
    const reflected = transformDisplayVector(vector.clone(), mirrored);
    expect(reflected.length()).toBeCloseTo(vector.length(), 12);
    expectVectorClose(transformDisplayVector(reflected, mirrored), vector);

    const normalCorners = cellImageCorners(normal.basis!, [0, 0, 0], center);
    const mirroredCorners = cellImageCorners(mirrored.basis!, [0, 0, 0], center);
    normalCorners.forEach((corner, index) => {
      const expected = corner.clone().sub(center)
        .applyMatrix3(mirrored.displayTransform)
        .add(center);
      expectVectorClose(mirroredCorners[index], expected);
    });
    expect([...source.arrays.get("positions")!]).toEqual([...positions]);
  });

  it("keeps reflected publication bonds and context physically equivalent", () => {
    const origin: CellOffset = [0.2, -0.1, 0.3];
    const source = frame(
      [
        ...toCartesian([0.65, -0.08, 0.25]).toArray(),
        ...toCartesian([-0.25, -0.06, 0.27]).toArray(),
      ],
      [...triclinicCell],
      [true, true, true],
    );
    const presentation: ScenePresentation = {
      ...basePresentation,
      cellOrigin: origin,
    };
    const reflectedPresentation: ScenePresentation = {
      ...presentation,
      mirror: [true, false, true],
    };
    const normal = prepareScene(manifest([6, 6], [[0, 1]]), source, presentation)!;
    const reflected = prepareScene(
      manifest([6, 6], [[0, 1]]),
      source,
      reflectedPresentation,
    )!;
    const normalPublication = publicationBondGeometry(normal, presentation, true);
    const reflectedPublication = publicationBondGeometry(reflected, reflectedPresentation, true);

    expect(reflectedPublication.contextAtoms.map(({ atomIndex, image }) => ({ atomIndex, image })))
      .toEqual(normalPublication.contextAtoms.map(({ atomIndex, image }) => ({ atomIndex, image })));
    expect(reflectedPublication.segments).toHaveLength(normalPublication.segments.length);
    normalPublication.segments.forEach((segment, index) => {
      const reflectedSegment = reflectedPublication.segments[index];
      const expectedFrom = segment.from.clone().sub(normal.cellCenter)
        .applyMatrix3(reflected.displayTransform)
        .add(normal.cellCenter);
      const expectedTo = segment.to.clone().sub(normal.cellCenter)
        .applyMatrix3(reflected.displayTransform)
        .add(normal.cellCenter);
      expectVectorClose(reflectedSegment.from, expectedFrom);
      expectVectorClose(reflectedSegment.to, expectedTo);
      expect(reflectedSegment.from.distanceTo(reflectedSegment.to))
        .toBeCloseTo(segment.from.distanceTo(segment.to), 6);
    });
  });

  it("uses unwrapped coordinates and their exact image identities", () => {
    const source = frame(
      [-4, 0, 0],
      [10, 0, 0, 0, 10, 0, 0, 0, 10],
      [true, true, true],
    );
    source.arrays.set("unwrapped_image_shifts", new Int32Array([1, 0, 0]));
    const scene = prepareScene(manifest([6]), source, {
      ...basePresentation,
      wrap: "unwrapped",
    })!;

    expect([...scene.positions]).toEqual([6, 0, 0]);
    expect([...scene.baseImages]).toEqual([1, 0, 0]);
    expect(atomSelectionForInstance(
      scene.instanceToAtom,
      scene.instanceImages,
      0,
      scene.baseImages,
    )).toEqual({ atom: 0, image: [1, 0, 0] });
  });

  it("keeps bonds short in unwrapped viewport and publication geometry", () => {
    const source = frame(
      [4.9, 0, 0, -4.9, 0, 0],
      [10, 0, 0, 0, 10, 0, 0, 0, 10],
      [true, true, true],
    );
    source.header.coordinates = "unwrapped";
    source.arrays.set("unwrapped_image_shifts", new Int32Array(6));
    const presentation: ScenePresentation = {
      ...basePresentation,
      wrap: "unwrapped",
    };
    const scene = prepareScene(manifest([6, 6], [[0, 1]]), source, presentation)!;

    const viewport = prepareFrameGeometry(scene, presentation, null);
    expect(viewport.bondSegments).toHaveLength(2);
    expectVectorClose(
      viewport.bondSegments[0].from,
      new THREE.Vector3().fromArray(scene.positions, 0),
    );
    expectVectorClose(
      viewport.bondSegments[1].from,
      new THREE.Vector3().fromArray(scene.positions, 3),
    );
    viewport.bondSegments.forEach((segment) => {
      expect(segment.from.distanceTo(segment.to)).toBeCloseTo(0.1, 5);
    });
    const publication = publicationBondGeometry(scene, presentation, true);
    expect(publication.segments).toHaveLength(2);
    expect(publication.segments.every(
      (segment) => Math.abs(segment.from.distanceTo(segment.to) - 0.2) < 1e-5,
    )).toBe(true);
  });

  it("centers an unwrapped structure on its displayed image", () => {
    const source = frame(
      [-4.8, 0, 0],
      [10, 0, 0, 0, 10, 0, 0, 0, 10],
      [true, true, true],
    );
    source.header.coordinates = "unwrapped";
    source.arrays.set("unwrapped_positions", new Float32Array([5.2, 0, 0]));
    source.arrays.set("unwrapped_image_shifts", new Int32Array([1, 0, 0]));

    const center = fractionalStructureCenter(source, 1);

    expect(center?.[0]).toBeCloseTo(0.52, 6);
    expect(center?.[1]).toBeCloseTo(0, 6);
    expect(center?.[2]).toBeCloseTo(0, 6);
  });

  it("centers structures and image-aware selections from raw coordinates", () => {
    const source = frame(
      [
        ...toCartesian([0.75, 0.2, -0.1]).toArray(),
        ...toCartesian([-0.25, 0.4, 0.3]).toArray(),
      ],
      [...triclinicCell],
      [true, true, true],
    );

    const full = fractionalStructureCenter(source, 2);
    expect(full?.[0]).toBeCloseTo(0.25, 6);
    expect(full?.[1]).toBeCloseTo(0.3, 6);
    expect(full?.[2]).toBeCloseTo(0.1, 6);
    const selected = fractionalStructureCenter(source, 2, [
      { atom: 0, image: [-1, 0, 0] },
      { atom: 1, image: [1, 0, 0] },
    ]);
    expect(selected?.[0]).toBeCloseTo(0.25, 6);
    expect(selected?.[1]).toBeCloseTo(0.3, 6);
    expect(selected?.[2]).toBeCloseTo(0.1, 6);
    expect(fractionalStructureCenter(source, 2, [])).toBeNull();
  });

  it("keeps a semantic molecule whole across the centered boundary", () => {
    const water = manifest([8, 1, 1], [[0, 1], [0, 2]]);
    water.topology.atom_residue_index = [0, 0, 0];
    water.topology.residues = [{ index: 0, type_id: 1, name: "H2O", category: "water" }];
    const source = frame(
      [4.8, 0, 0, -4.4, 0, 0, 4.8, 0.9, 0],
      [10, 0, 0, 0, 10, 0, 0, 0, 10],
      [true, true, true],
    );
    const scene = prepareScene(water, source, { ...basePresentation, wrap: "molecule" });

    expect(scene).not.toBeNull();
    const oxygen = new THREE.Vector3().fromArray(scene!.positions, 0);
    const hydrogen = new THREE.Vector3().fromArray(scene!.positions, 3);
    expect(oxygen.distanceTo(hydrogen)).toBeCloseTo(0.8, 5);
    const centroidX = (scene!.positions[0] + scene!.positions[3] + scene!.positions[6]) / 3;
    expect(centroidX).toBeGreaterThanOrEqual(-5);
    expect(centroidX).toBeLessThan(5);
    const publication = publicationBondGeometry(scene!, { ...basePresentation, wrap: "molecule" }, true);
    expect(publication.contextAtoms).toEqual([]);
    expect(publication.segments).toHaveLength(2);
    expect(publication.segments[0].from.distanceTo(publication.segments[0].to)).toBeCloseTo(0.8, 5);
  });

  it("keeps inferred plain-XYZ molecules whole across the boundary", () => {
    const water = manifest([8, 1, 1]);
    water.topology.bond_source = "inferred";
    const source = frame(
      [4.8, 0, 0, -4.4, 0, 0, 4.8, 0.9, 0],
      [10, 0, 0, 0, 10, 0, 0, 0, 10],
      [true, true, true],
    );
    const scene = prepareScene(water, source, { ...basePresentation, wrap: "molecule" });

    expect(scene?.bonds).toHaveLength(2);
    const oxygen = new THREE.Vector3().fromArray(scene!.positions, 0);
    expect(oxygen.distanceTo(new THREE.Vector3().fromArray(scene!.positions, 3))).toBeCloseTo(0.8, 5);
    expect(oxygen.distanceTo(new THREE.Vector3().fromArray(scene!.positions, 6))).toBeCloseTo(0.9, 5);
  });

  it("unwraps longer bonded molecules through bond connectivity", () => {
    const chain = manifest([6, 6, 6, 6], [[0, 1], [1, 2], [2, 3]]);
    const source = frame(
      [4, 0, 0, -4, 0, 0, -2, 0, 0, 0, 0, 0],
      [10, 0, 0, 0, 10, 0, 0, 0, 10],
      [true, true, true],
    );
    const scene = prepareScene(chain, source, { ...basePresentation, wrap: "molecule" })!;

    for (let atom = 0; atom < 3; atom += 1) {
      const left = new THREE.Vector3().fromArray(scene.positions, atom * 3);
      const right = new THREE.Vector3().fromArray(scene.positions, (atom + 1) * 3);
      expect(left.distanceTo(right)).toBeCloseTo(2, 6);
    }
  });
});

describe("scientific representations", () => {
  it("detects only an isolated O-H-H component as water", () => {
    const topology = manifest(
      [8, 1, 1, 6, 8, 1],
      [[0, 1], [0, 2], [3, 4], [4, 5]],
    );
    const source = frame([
      0, 0, 0,
      0.95, 0, 0,
      -0.24, 0.92, 0,
      5, 0, 0,
      6.4, 0, 0,
      7.35, 0, 0,
    ]);

    expect([...detectWaterAtoms(topology, source)].sort((left, right) => left - right)).toEqual([0, 1, 2]);
    const hidden = prepareScene(topology, source, { ...basePresentation, water: "hide" });
    const only = prepareScene(topology, source, { ...basePresentation, water: "only" });
    expect(hidden?.visibleAtoms).toEqual([3, 4, 5]);
    expect(only?.visibleAtoms).toEqual([0, 1, 2]);
  });

  it("uses the same strict water rule for geometry fallback", () => {
    const topology = manifest([8, 1, 1, 6, 8, 1]);
    topology.topology.bond_source = "inferred";
    const source = frame([
      0, 0, 0,
      0.95, 0, 0,
      -0.24, 0.92, 0,
      5, 0, 0,
      6.4, 0, 0,
      7.35, 0, 0,
    ]);

    expect([...detectWaterAtoms(topology, source)].sort((left, right) => left - right)).toEqual([0, 1, 2]);
  });

  it("abandons malformed dense bond inference without returning partial bonds", () => {
    const denseCount = Math.ceil((1 + Math.sqrt(1 + 8 * MAX_INFERRED_BOND_CANDIDATES)) / 2) + 1;
    const atomicNumbers = Array(denseCount + 2).fill(6);
    const positions = [0, 0, 0, 1, 0, 0];
    for (let atom = 0; atom < denseCount; atom += 1) positions.push(100, 0, 0);
    const topology = manifest(atomicNumbers);
    topology.topology.bond_source = "inferred";

    const scene = prepareScene(topology, frame(positions), basePresentation);

    expect(scene?.bonds).toEqual([]);
  });

  it("does not override an explicit non-water residue", () => {
    const topology = manifest([8, 1, 1], [[0, 1], [0, 2]]);
    topology.topology.atom_residue_index = [0, 0, 0];
    topology.topology.residues = [{ index: 0, type_id: 9, name: "LIG", category: "other" }];
    const source = frame([0, 0, 0, 0.95, 0, 0, -0.24, 0.92, 0]);

    expect([...detectWaterAtoms(topology, source)]).toEqual([]);
  });

  it("replicates only periodic axes and respects the atom budget", () => {
    const offsets = periodicImageOffsets([-1, -1, -1], [1, 1, 1], [true, false, true], 10);
    expect(offsets).toHaveLength(9);
    expect(offsets.every((offset) => offset[1] === 0)).toBe(true);
    expect(offsets).toContainEqual([0, 0, 0]);

    const limited = periodicImageOffsets([-2, -2, -2], [2, 2, 2], [true, true, true], 100_000);
    expect(limited).toHaveLength(2);
    expect(limited[0]).toEqual([0, 0, 0]);
  });

  it("maps filtered periodic instances back to base atoms", () => {
    const topology = manifest([8, 1, 1, 6], [[0, 1], [0, 2]]);
    const source = frame(
      [0, 0, 0, 0.95, 0, 0, -0.24, 0.92, 0, 2.5, 0, 0],
      [8, 0, 0, 0, 8, 0, 0, 0, 8],
      [true, false, false],
    );
    const scene = prepareScene(topology, source, {
      ...basePresentation,
      water: "hide",
      images: { min: [0, 0, 0], max: [1, 1, 1] },
    });

    expect([...scene!.instanceToAtom]).toEqual([3, 3]);
    expect([...scene!.instanceImages]).toEqual([0, 0, 0, 1, 0, 0]);
    const forces = new Float32Array([
      1, 0, 0,
      1, 0, 0,
      1, 0, 0,
      2, 0, 0,
    ]);
    expect(activeVectorInstances(scene!, forces)).toEqual({ instances: [0, 1], total: 2 });
  });

  it("indexes large semantic water sets without quadratic residue scans", () => {
    const residueCount = 30_000;
    const atomCount = residueCount * 3;
    const topology = manifest(Array.from({ length: atomCount }, (_, index) => index % 3 === 0 ? 8 : 1));
    topology.topology.atom_residue_index = Array.from({ length: atomCount }, (_, index) => Math.floor(index / 3));
    topology.topology.residues = Array.from({ length: residueCount }, (_, index) => ({
      index,
      type_id: 1,
      name: "H2O",
      category: "water",
    }));

    expect(detectWaterAtoms(topology, null).size).toBe(atomCount);
  });

  it("evenly caps force vectors across large structures", () => {
    const count = MAX_FORCE_VECTORS + 137;
    const topology = manifest(Array(count).fill(6));
    const positions = Array.from({ length: count * 3 }, (_, index) => index % 3 === 0 ? index / 3 : 0);
    const scene = prepareScene(topology, frame(positions), basePresentation)!;
    const forces = new Float32Array(count * 3);
    for (let atom = 0; atom < count; atom += 1) forces[atom * 3] = 1;

    const sampled = activeVectorInstances(scene, forces);
    expect(sampled.total).toBe(count);
    expect(sampled.instances).toHaveLength(MAX_FORCE_VECTORS);
    expect(sampled.instances[0]).toBe(0);
    expect(sampled.instances.at(-1)).toBe(count - 1);
    const geometry = prepareFrameGeometry(scene, { ...basePresentation, forces: true }, forces);
    expect(geometry.forceInstances).toHaveLength(MAX_FORCE_VECTORS);
    expect(geometry.forceTotal).toBe(count);
  });

  it("keeps a sparse structure fitted instead of an oversized primary cell", () => {
    expect(includeCellInFit(2, 20, [[0, 0, 0]])).toBe(false);
    expect(includeCellInFit(2, 6, [[0, 0, 0]])).toBe(true);
    expect(includeCellInFit(2, 20, [[1, 0, 0]])).toBe(true);
    expect(includeCellInFit(2, 20, [[0, 0, 0], [1, 0, 0]])).toBe(true);
  });

  it("treats cell translation as camera-stable but expansion as a new layout", () => {
    expect(imageLayoutShape([[0, 0, 0]])).toEqual(imageLayoutShape([[1, 0, 0]]));
    expect(imageLayoutShape([[-1, 0, 0], [0, 0, 0], [1, 0, 0]])).toEqual({
      count: 3,
      span: [2, 0, 0],
    });
    expect(imageLayoutShape([[0, 0, 0]])).not.toEqual(
      imageLayoutShape([[-1, 0, 0], [0, 0, 0], [1, 0, 0]]),
    );
  });

  it("uses distinct scientific radii for each atomic mode", () => {
    const ball = representationRadius(8, "ball-stick");
    const spacefill = representationRadius(8, "spacefill");
    expect(spacefill).toBeGreaterThan(ball * 4);
    expect(representationRadius(8, "licorice")).toBe(representationRadius(6, "licorice"));
    expect(representationRadius(8, "lines")).toBeLessThan(ball);
    expect(representationRadius(8, "ribbon")).toBe(0);
    expect(representationRadius(22, "ball-stick")).toBeGreaterThan(representationRadius(6, "ball-stick"));
    expect(representationRadius(78, "spacefill")).toBeGreaterThan(2);
    expect(representationRadius(92, "spacefill")).toBeGreaterThan(2.5);
  });

  it("uses adaptive mesh budgets and a hard point fallback", () => {
    const atomCount = MAX_ATOM_INSTANCES + 1;
    const presentation = { ...basePresentation, quality: "high" as const };
    const model: PreparedScene = {
      count: atomCount,
      atomicNumbers: [],
      positions: new Float32Array(),
      baseImages: new Int32Array(),
      basis: null,
      cellCenter: new THREE.Vector3(),
      displayTransform: new THREE.Matrix3(),
      pbc: [false, false, false],
      bonds: [],
      waterAtoms: new Set(),
      visibleAtoms: [],
      images: [[0, 0, 0]],
      instanceToAtom: new Uint32Array(atomCount),
      instanceImages: new Int8Array(),
      radii: [],
      backbone: [],
    };

    expect(usesHighDetailGeometry(presentation, MAX_HIGH_DETAIL_INSTANCES)).toBe(true);
    expect(usesHighDetailGeometry(presentation, MAX_HIGH_DETAIL_INSTANCES + 1)).toBe(false);
    expect(usesHighDetailGeometry(basePresentation, MAX_HIGH_DETAIL_INSTANCES)).toBe(false);
    expect(usesPointAtoms(presentation, 60_000)).toBe(false);
    expect(usesPointAtoms(basePresentation, 60_000)).toBe(false);
    expect(usesPointAtoms(presentation, MAX_SPHERE_INSTANCES)).toBe(false);
    expect(usesPointAtoms(presentation, MAX_SPHERE_INSTANCES + 1)).toBe(true);
    expect(usesPointAtoms(basePresentation, MAX_SPHERE_INSTANCES)).toBe(false);
    expect(usesPointAtoms(basePresentation, MAX_SPHERE_INSTANCES + 1)).toBe(true);
    expect(usesPointAtoms(presentation, 50_000 * 5)).toBe(true);
    expect(usesPointAtoms(presentation, atomCount)).toBe(true);
    expect(prepareFrameGeometry(model, presentation, null).atomKind).toBe("points");
    expect(periodicImageOffsets([0, 0, 0], [0, 0, 0], [true, true, true], atomCount)).toEqual([[0, 0, 0]]);

    const bondedReplicas: PreparedScene = {
      ...model,
      count: 2,
      atomicNumbers: [6, 6],
      positions: new Float32Array([0, 0, 0, 1.4, 0, 0]),
      bonds: [[0, 1]],
      visibleAtoms: [0, 1],
      images: [[-2, 0, 0], [-1, 0, 0], [0, 0, 0], [1, 0, 0], [2, 0, 0]],
      instanceToAtom: new Uint32Array(50_000 * 5),
      instanceImages: new Int8Array(50_000 * 5 * 3),
      radii: [0.3, 0.3],
    };
    const replicatedGeometry = prepareFrameGeometry(bondedReplicas, presentation, null);
    expect(replicatedGeometry.atomKind).toBe("points");
    expect(replicatedGeometry.bondKind).toBe("lines");
    expect(replicatedGeometry.bondSegments).toHaveLength(5);
  });

  it("switches dense replicated bonds to lines independently of atoms", () => {
    const images: PreparedScene["images"] = [];
    for (let a = -2; a <= 2; a += 1) {
      for (let b = -2; b <= 2; b += 1) {
        for (let c = -2; c <= 2; c += 1) images.push([a, b, c]);
      }
    }
    const denseBonds: Array<[number, number]> = [];
    for (let a = 0; a < 100 && denseBonds.length <= 640; a += 1) {
      for (let b = a + 1; b < 100 && denseBonds.length <= 640; b += 1) denseBonds.push([a, b]);
    }
    const denseBondModel: PreparedScene = {
      count: 100,
      atomicNumbers: Array(100).fill(6),
      positions: new Float32Array(300),
      baseImages: new Int32Array(300),
      basis: null,
      cellCenter: new THREE.Vector3(),
      displayTransform: new THREE.Matrix3(),
      pbc: [false, false, false],
      bonds: denseBonds,
      waterAtoms: new Set(),
      visibleAtoms: Array.from({ length: 100 }, (_, atom) => atom),
      images,
      instanceToAtom: new Uint32Array(12_500),
      instanceImages: new Int8Array(37_500),
      radii: Array(100).fill(0.3),
      backbone: [],
    };
    const presentation = { ...basePresentation, quality: "high" as const };
    const atLimit = prepareFrameGeometry(
      { ...denseBondModel, bonds: denseBonds.slice(0, MAX_BOND_INSTANCES / images.length) },
      presentation,
      null,
    );
    const aboveLimit = prepareFrameGeometry(denseBondModel, presentation, null);
    expect(atLimit.atomKind).toBe("instances");
    expect(atLimit.bondSegments).toHaveLength(MAX_BOND_INSTANCES);
    expect(atLimit.bondKind).toBe("instances");
    expect(aboveLimit.atomKind).toBe("instances");
    expect(aboveLimit.bondSegments).toHaveLength(MAX_BOND_INSTANCES + 125);
    expect(aboveLimit.bondKind).toBe("lines");
  });

  it("clears damped orbit motion before every camera reset view", () => {
    const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 5000);
    camera.position.set(4, 3, 6);
    const element = {
      addEventListener() {},
      removeEventListener() {},
      getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }),
      style: {},
      clientHeight: 800,
    } as unknown as HTMLElement;
    const controls = new OrbitControls(camera, element);
    controls.enableDamping = true;
    const internals = controls as OrbitControls & {
      _sphericalDelta: THREE.Spherical;
      _panOffset: THREE.Vector3;
    };
    const views = [
      { position: new THREE.Vector3(8, 5, 9), up: new THREE.Vector3(0, 1, 0) },
      { position: new THREE.Vector3(1, 2, 11), up: new THREE.Vector3(0, 1, 0) },
      { position: new THREE.Vector3(1, 10, 3), up: new THREE.Vector3(0, 0, 1) },
      { position: new THREE.Vector3(10, 2, 3), up: new THREE.Vector3(0, 0, 1) },
    ];
    for (const view of views) {
      internals._sphericalDelta.theta = 0.8;
      internals._sphericalDelta.phi = -0.4;
      internals._panOffset.set(2, 1, -1);
      clearOrbitMotion(controls);
      camera.up.copy(view.up);
      camera.position.copy(view.position);
      controls.target.set(1, 2, 3);
      controls.update();
      const position = camera.position.clone();
      const target = controls.target.clone();
      for (let index = 0; index < 20; index += 1) controls.update();
      expectVectorClose(camera.position, position);
      expectVectorClose(controls.target, target);
    }
    controls.dispose();
  });

  it("offers ribbon only for complete ordered protein backbones", () => {
    const topology = manifest(Array(12).fill(6));
    topology.topology.atomic_numbers = [7, 6, 6, 8, 7, 6, 6, 8, 7, 6, 6, 8];
    topology.topology.atom_names = ["N", "CA", "C", "O", "N", "CA", "C", "O", "N", "CA", "C", "O"];
    topology.topology.atom_residue_index = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2];
    topology.topology.residues = [0, 1, 2].map((index) => ({
      index,
      type_id: 1,
      name: "ALA",
      category: "amino-acid" as const,
    }));

    const capability = sceneCapabilities(topology, null);
    expect(capability.ribbon).toBe(true);
    expect(capability.suggestedProfile).toBe("protein");

    topology.topology.atom_names[9] = "CB";
    const unavailable = sceneCapabilities(topology, null);
    expect(unavailable.ribbon).toBe(false);
    expect(unavailable.ribbonReason.length).toBeGreaterThan(0);
  });

  it("infers a protein backbone from residue and bonded topology", () => {
    const topology = manifest(Array(12).fill(6));
    topology.topology.atomic_numbers = [7, 6, 6, 8, 7, 6, 6, 8, 7, 6, 6, 8];
    topology.topology.atom_names = ["N", "C", "C", "O", "N", "C", "C", "O", "N", "C", "C", "O"];
    topology.topology.atom_residue_index = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2];
    topology.topology.residues = [0, 1, 2].map((index) => ({
      index,
      type_id: 1,
      name: "ALA",
      category: "amino-acid" as const,
    }));
    topology.topology.bonds = [
      [0, 1], [1, 2], [2, 3], [2, 4],
      [4, 5], [5, 6], [6, 7], [6, 8],
      [8, 9], [9, 10], [10, 11],
    ];

    expect(backboneResidues(topology).map(({ n, ca, c, o }) => [n, ca, c, o])).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10, 11],
    ]);
    expect(sceneCapabilities(topology, null).ribbon).toBe(true);

    topology.topology.bonds = topology.topology.bonds.filter((bond) => (
      Array.isArray(bond) && !(bond[0] === 6 && bond[1] === 8)
    ));
    expect(sceneCapabilities(topology, null).ribbon).toBe(false);
  });
});

describe("trajectory geometry reuse", () => {
  it("keeps the GPU layout stable when only coordinates and cell values change", () => {
    const topology = manifest([6, 6], [[0, 1]]);
    const first = prepareScene(topology, frame(
      [0, 0, 0, 1.4, 0, 0],
      [8, 0, 0, 0, 8, 0, 0, 0, 8],
      [true, true, true],
    ), basePresentation)!;
    const second = prepareScene(topology, frame(
      [0.2, 0.1, 0, 1.55, 0.1, 0],
      [8.2, 0, 0, 0, 7.9, 0, 0, 0, 8.1],
      [true, true, true],
    ), basePresentation)!;

    const firstGeometry = prepareFrameGeometry(first, basePresentation, null);
    const secondGeometry = prepareFrameGeometry(second, basePresentation, null);
    expect(firstGeometry.atomKind).toBe("instances");
    expect(firstGeometry.atomCount).toBe(2);
    expect(firstGeometry.bondSegments).toHaveLength(1);
    expect(firstGeometry.cellLineCount).toBe(12);
    expect(sameFrameGeometryLayout(
      frameGeometryLayout(firstGeometry),
      frameGeometryLayout(secondGeometry),
    )).toBe(true);
  });

  it("requires a rebuild when bond or active-vector counts change", () => {
    const topology = manifest([6, 6], [[0, 1]]);
    const cell = [10, 0, 0, 0, 10, 0, 0, 0, 10];
    const inside = prepareScene(topology, frame(
      [0, 0, 0, 1.4, 0, 0],
      cell,
      [true, true, true],
    ), { ...basePresentation, forces: true })!;
    const crossing = prepareScene(topology, frame(
      [4.8, 0, 0, -4.8, 0, 0],
      cell,
      [true, true, true],
    ), { ...basePresentation, forces: true })!;
    const bothForces = new Float32Array([1, 0, 0, -1, 0, 0]);
    const oneForce = new Float32Array([1, 0, 0, 0, 0, 0]);
    const bothVelocities = new Float32Array([0, 1, 0, 0, -1, 0]);
    const oneVelocity = new Float32Array([0, 1, 0, 0, 0, 0]);
    const presentation = { ...basePresentation, forces: true, velocities: true };

    const stable = prepareFrameGeometry(inside, presentation, bothForces, bothVelocities);
    const changedBonds = prepareFrameGeometry(crossing, presentation, bothForces, bothVelocities);
    const changedForces = prepareFrameGeometry(inside, presentation, oneForce, bothVelocities);
    const changedVelocities = prepareFrameGeometry(inside, presentation, bothForces, oneVelocity);
    expect(stable.bondSegments).toHaveLength(1);
    expect(changedBonds.bondSegments).toHaveLength(2);
    expect(stable.forceInstances).toHaveLength(2);
    expect(changedForces.forceInstances).toHaveLength(1);
    expect(stable.velocityInstances).toHaveLength(2);
    expect(changedVelocities.velocityInstances).toHaveLength(1);
    expect(sameFrameGeometryLayout(
      frameGeometryLayout(stable),
      frameGeometryLayout(changedBonds),
    )).toBe(false);
    expect(sameFrameGeometryLayout(
      frameGeometryLayout(stable),
      frameGeometryLayout(changedForces),
    )).toBe(false);
    expect(sameFrameGeometryLayout(
      frameGeometryLayout(stable),
      frameGeometryLayout(changedVelocities),
    )).toBe(false);
  });
});

describe("trajectory overlays", () => {
  it("anchors unwrapped trails to the selected periodic image", () => {
    const topology = manifest([1]);
    const current = frame(
      [-4.8, 0, 0],
      [10, 0, 0, 0, 10, 0, 0, 0, 10],
      [true, true, true],
    );
    const model = prepareScene(topology, current, basePresentation)!;
    const segments = alignedTrailSegments(model, {
      id: "h1",
      atom: 0,
      image: [1, 0, 0],
      points: new Float32Array([4.7, 0, 0, 4.9, 0, 0, 5.2, 0, 0]),
    });

    [
      4.7, 0, 0, 4.9, 0, 0,
      4.9, 0, 0, 5.2, 0, 0,
    ].forEach((value, index) => expect(segments[index]).toBeCloseTo(value, 5));
    expectVectorClose(
      selectedDisplayedPosition(model, 0, [1, 0, 0])!,
      new THREE.Vector3(5.2, 0, 0),
    );
  });

  it("mirrors trail displacements with the displayed cell", () => {
    const topology = manifest([1]);
    const model = prepareScene(
      topology,
      frame(
        [1, 0, 0],
        [10, 0, 0, 0, 10, 0, 0, 0, 10],
        [true, true, true],
      ),
      { ...basePresentation, mirror: [true, false, false] },
    )!;
    const segments = alignedTrailSegments(model, {
      id: "h1",
      atom: 0,
      image: [0, 0, 0],
      points: new Float32Array([0, 0, 0, 0.5, 0, 0, 1, 0, 0]),
    });

    expect([...segments]).toEqual([
      0, 0, 0, -0.5, 0, 0,
      -0.5, 0, 0, -1, 0, 0,
    ]);
  });

  it("bounds trail points and splits invalid samples", () => {
    const topology = manifest([1]);
    const model = prepareScene(topology, frame([0, 0, 0]), basePresentation)!;
    const points = new Float32Array(520 * 3);
    for (let index = 0; index < 520; index += 1) points[index * 3] = index;
    points[(520 - 3) * 3] = Number.NaN;
    const segments = alignedTrailSegments(model, {
      id: "bounded",
      atom: 0,
      image: [0, 0, 0],
      points,
    });

    expect(segments.length).toBeLessThanOrEqual((512 - 1) * 6);
    expect([...segments].every(Number.isFinite)).toBe(true);
  });
});
