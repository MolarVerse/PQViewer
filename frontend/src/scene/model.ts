import * as THREE from "three";
import { frameArray } from "../api";
import type {
  CellOffset,
  FrameData,
  Manifest,
  RepresentationMode,
  ScenePresentation,
} from "../types";

export type Pbc = [boolean, boolean, boolean];

export interface CellBasis {
  vectors: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  reciprocal: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
}

export interface Segment {
  from: THREE.Vector3;
  to: THREE.Vector3;
}

export interface BackboneResidue {
  residueIndex: number;
  n: number;
  ca: number;
  c: number;
  o: number;
}

export interface PreparedScene {
  count: number;
  atomicNumbers: number[];
  positions: Float32Array;
  basis: CellBasis | null;
  pbc: Pbc;
  bonds: Array<[number, number]>;
  waterAtoms: Set<number>;
  visibleAtoms: number[];
  images: CellOffset[];
  instanceToAtom: Uint32Array;
  instanceImages: Int8Array;
  radii: number[];
  backbone: BackboneResidue[];
}

export interface PreparedTopology {
  count: number;
  atomicNumbers: number[];
  bonds: Array<[number, number]>;
  waterAtoms: Set<number>;
}

export interface FrameGeometryPlan {
  atomKind: "none" | "points" | "instances";
  atomCount: number;
  bondKind: "none" | "lines" | "instances";
  bondSegments: Segment[];
  cellLineCount: number;
  forceInstances: number[];
  forceTotal: number;
}

export interface FrameGeometryLayout {
  atomKind: FrameGeometryPlan["atomKind"];
  atomCount: number;
  bondKind: FrameGeometryPlan["bondKind"];
  bondCount: number;
  cellLineCount: number;
  forceCount: number;
}

export interface ImageLayoutShape {
  count: number;
  span: CellOffset;
}

export const MAX_PERIODIC_IMAGES = 125;
export const MAX_ATOM_INSTANCES = 250_000;
export const MAX_INFERRED_BOND_CANDIDATES = 2_000_000;
export const MAX_FORCE_VECTORS = 12_000;

const MAX_INFERRED_BONDS = 250_000;
const MAX_INFERRED_BOND_CELL_PROBES = 40_000_000;
const MAX_INFERRED_BOND_SHIFTS = 729;

const waterNames = new Set([
  "H2O", "HOH", "OH2", "WAT", "WATER", "TIP3", "TIP3P", "TIP4", "TIP4P", "SPC", "SPCE",
]);

const aminoAcidNames = new Set([
  "ALA", "ARG", "ASN", "ASP", "CYS", "GLN", "GLU", "GLY", "HIS", "ILE",
  "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL",
  "ASH", "CYX", "GLH", "HID", "HIE", "HIP", "LYN", "MSE",
]);

export function prepareScene(
  manifest: Manifest,
  frame: FrameData | null,
  presentation: ScenePresentation,
  preparedTopology?: PreparedTopology | null,
): PreparedScene | null {
  const source = frameArray(frame, ["positions", "position", "pos", "coordinates", "coords"]);
  if (!source) return null;

  const count = Math.min(manifest.topology.atom_count, Math.floor(source.length / 3));
  const basis = createCellBasis(frameArray(frame, ["cell", "cell_vectors", "box"]));
  const pbc = resolvePbc(frame, basis);
  const bondPositions = wrapPositions(source, count, basis, pbc);
  const topology = preparedTopology?.count === count
    ? preparedTopology
    : prepareTopology(manifest, frame);
  if (!topology) return null;
  const { atomicNumbers, bonds, waterAtoms } = topology;
  const positions = presentation.wrap === "none"
    ? new Float32Array(source.subarray(0, count * 3))
    : presentation.wrap === "molecule"
      ? wrapMolecules(source, count, basis, pbc, moleculeGroups(manifest, count, bonds), bonds)
      : bondPositions;
  const visibleAtoms = visibleAtomIndices(atomicNumbers, waterAtoms, presentation);
  const images = periodicImageOffsets(presentation.images.min, presentation.images.max, pbc, visibleAtoms.length);
  const { instanceToAtom, instanceImages } = instanceMapping(visibleAtoms, images);
  const radii = atomicNumbers.map((number) => representationRadius(number, presentation.mode, presentation.atomScale));

  return {
    count,
    atomicNumbers,
    positions,
    basis,
    pbc,
    bonds,
    waterAtoms,
    visibleAtoms,
    images,
    instanceToAtom,
    instanceImages,
    radii,
    backbone: backboneResidues(manifest),
  };
}

export function prepareTopology(manifest: Manifest, frame: FrameData | null): PreparedTopology | null {
  const source = frameArray(frame, ["positions", "position", "pos", "coordinates", "coords"]);
  if (!source) return null;
  const count = Math.min(manifest.topology.atom_count, Math.floor(source.length / 3));
  const atomicNumbers = resolveAtomicNumbers(manifest, count);
  const basis = createCellBasis(frameArray(frame, ["cell", "cell_vectors", "box"]));
  const pbc = resolvePbc(frame, basis);
  const declared = normalizeBonds(manifest.topology.bonds, count);
  const positions = wrapPositions(source, count, basis, pbc);
  const bonds = manifest.topology.bond_source === "topology"
    ? declared
    : declared.length > 0
      ? declared
      : inferCovalentBonds(positions, atomicNumbers, count, basis, pbc);
  return {
    count,
    atomicNumbers,
    bonds,
    waterAtoms: detectWaterAtoms(manifest, frame, bonds),
  };
}

export function centeredFramePositions(frame: FrameData | null, count: number): Float32Array | null {
  const positions = frameArray(frame, ["positions", "position", "pos", "coordinates", "coords"]);
  if (!positions) return null;
  const basis = createCellBasis(frameArray(frame, ["cell", "cell_vectors", "box"]));
  return wrapPositions(positions, Math.min(count, Math.floor(positions.length / 3)), basis, resolvePbc(frame, basis));
}

export function hasFrameCell(frame: FrameData | null): boolean {
  return Boolean(createCellBasis(frameArray(frame, ["cell", "cell_vectors", "box"])));
}

export function framePbc(frame: FrameData | null): Pbc {
  const basis = createCellBasis(frameArray(frame, ["cell", "cell_vectors", "box"]));
  return resolvePbc(frame, basis);
}

export function createCellBasis(cell: Float32Array | null): CellBasis | null {
  if (!cell || cell.length < 9) return null;
  const a = new THREE.Vector3(cell[0], cell[1], cell[2]);
  const b = new THREE.Vector3(cell[3], cell[4], cell[5]);
  const c = new THREE.Vector3(cell[6], cell[7], cell[8]);
  const bCrossC = new THREE.Vector3().crossVectors(b, c);
  const determinant = a.dot(bCrossC);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
  return {
    vectors: [a, b, c],
    reciprocal: [
      bCrossC.multiplyScalar(1 / determinant),
      new THREE.Vector3().crossVectors(c, a).multiplyScalar(1 / determinant),
      new THREE.Vector3().crossVectors(a, b).multiplyScalar(1 / determinant),
    ],
  };
}

export function resolvePbc(frame: FrameData | null, basis: CellBasis | null): Pbc {
  if (!basis) return [false, false, false];
  const values = frame?.header.pbc;
  if (!values) return [true, true, true];
  return [Boolean(values[0]), Boolean(values[1]), Boolean(values[2])];
}

export function periodicImageOffsets(
  requestedMin: CellOffset,
  requestedMax: CellOffset,
  pbc: Pbc,
  visibleAtomCount: number,
): CellOffset[] {
  const min = requestedMin.map((value, axis) => pbc[axis] ? clampImage(value) : 0) as CellOffset;
  const max = requestedMax.map((value, axis) => pbc[axis] ? clampImage(value) : 0) as CellOffset;
  const low = min.map((value, axis) => Math.min(value, max[axis])) as CellOffset;
  const high = max.map((value, axis) => Math.max(value, min[axis])) as CellOffset;
  const result: CellOffset[] = [];
  for (let a = low[0]; a <= high[0]; a += 1) {
    for (let b = low[1]; b <= high[1]; b += 1) {
      for (let c = low[2]; c <= high[2]; c += 1) result.push([a, b, c]);
    }
  }
  result.sort((left, right) => imageDistance(left) - imageDistance(right)
    || left[0] - right[0]
    || left[1] - right[1]
    || left[2] - right[2]);
  const atomLimit = visibleAtomCount > 0
    ? Math.max(1, Math.floor(MAX_ATOM_INSTANCES / visibleAtomCount))
    : MAX_PERIODIC_IMAGES;
  return result.slice(0, Math.min(MAX_PERIODIC_IMAGES, atomLimit));
}

export function instanceMapping(
  visibleAtoms: number[],
  images: CellOffset[],
): { instanceToAtom: Uint32Array; instanceImages: Int8Array } {
  const count = visibleAtoms.length * images.length;
  const instanceToAtom = new Uint32Array(count);
  const instanceImages = new Int8Array(count * 3);
  let instance = 0;
  for (const image of images) {
    for (const atom of visibleAtoms) {
      instanceToAtom[instance] = atom;
      instanceImages.set(image, instance * 3);
      instance += 1;
    }
  }
  return { instanceToAtom, instanceImages };
}

export function activeVectorInstances(
  model: PreparedScene,
  values: Float32Array | null,
): { instances: number[]; total: number } {
  if (!values || values.length < model.count * 3) return { instances: [], total: 0 };
  let total = 0;
  for (let instance = 0; instance < model.instanceToAtom.length; instance += 1) {
    const atom = model.instanceToAtom[instance];
    const offset = atom * 3;
    const x = values[offset];
    const y = values[offset + 1];
    const z = values[offset + 2];
    const magnitudeSquared = x * x + y * y + z * z;
    if (Number.isFinite(magnitudeSquared) && magnitudeSquared > 1e-24) total += 1;
  }
  if (total === 0) return { instances: [], total: 0 };

  const sampleCount = Math.min(total, MAX_FORCE_VECTORS);
  const instances: number[] = [];
  let activeIndex = 0;
  let sampleIndex = 0;
  let target = Math.floor((sampleIndex + 0.5) * total / sampleCount);
  for (let instance = 0; instance < model.instanceToAtom.length && sampleIndex < sampleCount; instance += 1) {
    const atom = model.instanceToAtom[instance];
    const offset = atom * 3;
    const x = values[offset];
    const y = values[offset + 1];
    const z = values[offset + 2];
    const magnitudeSquared = x * x + y * y + z * z;
    if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= 1e-24) continue;
    if (activeIndex >= target) {
      instances.push(instance);
      sampleIndex += 1;
      target = Math.floor((sampleIndex + 0.5) * total / sampleCount);
    }
    activeIndex += 1;
  }
  return { instances, total };
}

export function prepareFrameGeometry(
  model: PreparedScene,
  presentation: ScenePresentation,
  forces: Float32Array | null,
): FrameGeometryPlan {
  const atomCount = model.instanceToAtom.length;
  const pointAtoms = usesPointAtoms(presentation, atomCount);
  const atomKind = presentation.mode === "ribbon" || atomCount === 0
    ? "none"
    : pointAtoms ? "points" : "instances";
  const bondSegments = sceneBondSegments(model, presentation);
  const bondKind = bondSegments.length === 0
    ? "none"
    : presentation.mode === "lines" ? "lines" : "instances";
  const forceVectors = presentation.forces
    ? activeVectorInstances(model, forces)
    : { instances: [], total: 0 };
  return {
    atomKind,
    atomCount,
    bondKind,
    bondSegments,
    cellLineCount: presentation.cell && model.basis ? model.images.length * 12 : 0,
    forceInstances: forceVectors.instances,
    forceTotal: forceVectors.total,
  };
}

export function usesPointAtoms(presentation: ScenePresentation, atomCount: number): boolean {
  return presentation.mode === "lines"
    || atomCount > MAX_ATOM_INSTANCES
    || (presentation.quality === "auto" && atomCount > 80_000);
}

export function frameGeometryLayout(plan: FrameGeometryPlan): FrameGeometryLayout {
  return {
    atomKind: plan.atomKind,
    atomCount: plan.atomCount,
    bondKind: plan.bondKind,
    bondCount: plan.bondSegments.length,
    cellLineCount: plan.cellLineCount,
    forceCount: plan.forceInstances.length,
  };
}

export function sameFrameGeometryLayout(left: FrameGeometryLayout, right: FrameGeometryLayout): boolean {
  return left.atomKind === right.atomKind
    && left.atomCount === right.atomCount
    && left.bondKind === right.bondKind
    && left.bondCount === right.bondCount
    && left.cellLineCount === right.cellLineCount
    && left.forceCount === right.forceCount;
}

export function sceneBondSegments(
  model: PreparedScene,
  presentation: ScenePresentation,
): Segment[] {
  if (presentation.mode === "spacefill" || presentation.mode === "ribbon") return [];
  const visible = new Set(model.visibleAtoms);
  const segments: Segment[] = [];
  for (const image of model.images) {
    const shift = imageTranslation(image, model.basis);
    for (const [a, b] of model.bonds) {
      if (!visible.has(a) || !visible.has(b)) continue;
      const base = presentation.wrap === "atom"
        ? periodicBondSegments(model.positions, a, b, model.basis, model.pbc)
        : [directBondSegment(model.positions, a, b)];
      base.forEach(({ from, to }) => segments.push({ from: from.add(shift), to: to.add(shift) }));
    }
  }
  return segments;
}

export function includeCellInFit(atomSpan: number, cellSpan: number, images: CellOffset[]): boolean {
  const expandedImages = images.length > 1 || images.some((image) => image.some((value) => value !== 0));
  return expandedImages || atomSpan === 0 || cellSpan <= atomSpan * 3.2;
}

export function imageLayoutShape(images: CellOffset[]): ImageLayoutShape {
  if (images.length === 0) return { count: 0, span: [0, 0, 0] };
  const low: CellOffset = [...images[0]];
  const high: CellOffset = [...images[0]];
  for (const image of images.slice(1)) {
    for (let axis = 0; axis < 3; axis += 1) {
      low[axis] = Math.min(low[axis], image[axis]);
      high[axis] = Math.max(high[axis], image[axis]);
    }
  }
  return {
    count: images.length,
    span: [high[0] - low[0], high[1] - low[1], high[2] - low[2]],
  };
}

export function detectWaterAtoms(
  manifest: Manifest,
  frame: FrameData | null,
  knownBonds?: Array<[number, number]>,
): Set<number> {
  const source = frameArray(frame, ["positions", "position", "pos", "coordinates", "coords"]);
  const count = Math.min(manifest.topology.atom_count, Math.floor((source?.length ?? 0) / 3));
  const atomicNumbers = resolveAtomicNumbers(manifest, manifest.topology.atom_count);
  const result = new Set<number>();
  const semanticAtoms = new Set<number>();
  const residuesByIndex = new Map(
    (manifest.topology.residues ?? []).map((residue) => [residue.index, residue]),
  );

  for (const [residueIndex, atoms] of semanticGroups(manifest, manifest.topology.atom_count)) {
    atoms.forEach((atom) => semanticAtoms.add(atom));
    const residue = residuesByIndex.get(residueIndex);
    if (!residue) continue;
    if ((residue.category === "water" || waterNames.has((residue.name ?? "").trim().toUpperCase()))
      && isWaterComposition(atoms, atomicNumbers)) {
      atoms.forEach((atom) => result.add(atom));
    }
  }

  if (!source || count === 0) return result;
  const basis = createCellBasis(frameArray(frame, ["cell", "cell_vectors", "box"]));
  const pbc = resolvePbc(frame, basis);
  const positions = wrapPositions(source, count, basis, pbc);
  const bonds = knownBonds ?? normalizeBonds(manifest.topology.bonds, count);
  const fallbackBonds = knownBonds !== undefined || bonds.length > 0
    ? bonds
    : inferCovalentBonds(positions, atomicNumbers, count, basis, pbc);
  for (const component of connectedComponents(count, fallbackBonds)) {
    if (component.some((atom) => semanticAtoms.has(atom))) continue;
    if (isWaterComposition(component, atomicNumbers) && isIsolatedWater(component, fallbackBonds, atomicNumbers)) {
      component.forEach((atom) => result.add(atom));
    }
  }
  return result;
}

export function backboneResidues(manifest: Manifest): BackboneResidue[] {
  const names = manifest.topology.atom_names;
  if (!manifest.topology.residues?.length) return [];
  const groups = new Map(semanticGroups(manifest, manifest.topology.atom_count));
  const atomicNumbers = resolveAtomicNumbers(manifest, manifest.topology.atom_count);
  const bonds = normalizeBonds(manifest.topology.bonds, manifest.topology.atom_count);
  const adjacency = bondAdjacency(manifest.topology.atom_count, bonds);
  const result: BackboneResidue[] = [];
  for (const residue of [...manifest.topology.residues].sort((left, right) => left.index - right.index)) {
    if (residue.category !== "amino-acid" && !aminoAcidNames.has((residue.name ?? "").trim().toUpperCase())) continue;
    const atoms = groups.get(residue.index) ?? [];
    const named = names?.length ? namedBackbone(residue.index, atoms, names, atomicNumbers) : null;
    const inferred = manifest.topology.bond_source === "topology"
      ? inferredBackbone(residue.index, atoms, atomicNumbers, adjacency)
      : null;
    if (named ?? inferred) result.push((named ?? inferred)!);
  }
  return longestBackboneRun(result, bonds);
}

export function representationRadius(
  atomicNumber: number,
  mode: RepresentationMode,
  scale = 1,
): number {
  const safeScale = Number.isFinite(scale) ? Math.max(0.1, scale) : 1;
  if (mode === "spacefill") return vanDerWaalsRadius(atomicNumber) * safeScale;
  if (mode === "licorice") return 0.22 * safeScale;
  if (mode === "lines") return 0.075 * safeScale;
  if (mode === "ribbon") return 0;
  return Math.max(0.22, (covalentRadii[atomicNumber] ?? 0.78) * 0.43) * safeScale;
}

export function periodicBondSegments(
  positions: Float32Array,
  aIndex: number,
  bIndex: number,
  basis: CellBasis | null,
  pbc: Pbc,
): Segment[] {
  const a = new THREE.Vector3().fromArray(positions, aIndex * 3);
  const b = new THREE.Vector3().fromArray(positions, bIndex * 3);
  if (!basis || !pbc.some(Boolean)) return [{ from: a, to: b }];

  const start = toFractional(a, basis);
  const directDelta = toFractional(b, basis).sub(start);
  const delta = minimumImageFraction(directDelta, basis, pbc);
  const crossings = [0, 1];
  const starts = [start.x, start.y, start.z];
  const changes = [delta.x, delta.y, delta.z];
  for (let axis = 0; axis < 3; axis += 1) {
    if (!pbc[axis] || Math.abs(changes[axis]) < 1e-12) continue;
    const end = starts[axis] + changes[axis];
    const low = Math.min(starts[axis], end);
    const high = Math.max(starts[axis], end);
    const firstFace = Math.ceil(low - 0.5 + 1e-9);
    const lastFace = Math.floor(high - 0.5 - 1e-9);
    for (let image = firstFace; image <= lastFace; image += 1) {
      const time = (image + 0.5 - starts[axis]) / changes[axis];
      if (time > 1e-9 && time < 1 - 1e-9) crossings.push(time);
    }
  }
  crossings.sort((left, right) => left - right);
  const times = crossings.filter((value, index) => index === 0 || Math.abs(value - crossings[index - 1]) > 1e-8);
  const result: Segment[] = [];
  for (let index = 0; index + 1 < times.length; index += 1) {
    const fromTime = times[index];
    const toTime = times[index + 1];
    const middle = start.clone().addScaledVector(delta, (fromTime + toTime) * 0.5);
    const shift = new THREE.Vector3(
      pbc[0] ? Math.floor(middle.x + 0.5) : 0,
      pbc[1] ? Math.floor(middle.y + 0.5) : 0,
      pbc[2] ? Math.floor(middle.z + 0.5) : 0,
    );
    const from = toCartesian(start.clone().addScaledVector(delta, fromTime).sub(shift), basis);
    const to = toCartesian(start.clone().addScaledVector(delta, toTime).sub(shift), basis);
    if (from.distanceToSquared(to) > 1e-10) result.push({ from, to });
  }
  return result;
}

export function imageTranslation(offset: CellOffset, basis: CellBasis | null): THREE.Vector3 {
  return basis ? toCartesian(new THREE.Vector3(...offset), basis) : new THREE.Vector3();
}

export function cellImageCorners(basis: CellBasis, offset: CellOffset): THREE.Vector3[] {
  const corners: THREE.Vector3[] = [];
  for (let a = 0; a <= 1; a += 1) {
    for (let b = 0; b <= 1; b += 1) {
      for (let c = 0; c <= 1; c += 1) {
        corners.push(imageTranslation(
          [offset[0] + a, offset[1] + b, offset[2] + c],
          basis,
        ).addScaledVector(basis.vectors[0], -0.5)
          .addScaledVector(basis.vectors[1], -0.5)
          .addScaledVector(basis.vectors[2], -0.5));
      }
    }
  }
  return corners;
}

export function unwrapPointNear(
  reference: THREE.Vector3,
  point: THREE.Vector3,
  basis: CellBasis | null,
  pbc: Pbc,
): THREE.Vector3 {
  if (!basis || !pbc.some(Boolean)) return point.clone();
  const referenceFraction = toFractional(reference, basis);
  const delta = minimumImageFraction(toFractional(point, basis).sub(referenceFraction), basis, pbc);
  return reference.clone().add(toCartesian(delta, basis));
}

export function directBondSegment(positions: Float32Array, a: number, b: number): Segment {
  return {
    from: new THREE.Vector3().fromArray(positions, a * 3),
    to: new THREE.Vector3().fromArray(positions, b * 3),
  };
}

function visibleAtomIndices(
  atomicNumbers: number[],
  waterAtoms: Set<number>,
  presentation: ScenePresentation,
): number[] {
  const result: number[] = [];
  for (let atom = 0; atom < atomicNumbers.length; atom += 1) {
    const isWater = waterAtoms.has(atom);
    if (!presentation.hydrogens && atomicNumbers[atom] === 1) continue;
    if (presentation.water === "hide" && isWater) continue;
    if (presentation.water === "only" && !isWater) continue;
    result.push(atom);
  }
  return result;
}

function wrapMolecules(
  source: Float32Array,
  count: number,
  basis: CellBasis | null,
  pbc: Pbc,
  groups: Array<[number, number[]]>,
  bonds: Array<[number, number]>,
): Float32Array {
  if (!basis || !pbc.some(Boolean) || groups.length === 0) return wrapPositions(source, count, basis, pbc);
  const result = new Float32Array(source.subarray(0, count * 3));
  const grouped = new Set<number>();
  const point = new THREE.Vector3();
  const sourceFractions = Array.from({ length: count }, (_, atom) => (
    toFractional(point.fromArray(source, atom * 3), basis)
  ));
  const adjacency = Array.from({ length: count }, () => [] as number[]);
  bonds.forEach(([a, b]) => {
    adjacency[a]?.push(b);
    adjacency[b]?.push(a);
  });
  for (const [, atoms] of groups) {
    if (atoms.length === 0) continue;
    atoms.forEach((atom) => grouped.add(atom));
    const members = new Set(atoms);
    const unwrapped = new Map<number, THREE.Vector3>();
    const anchor = atoms[0];
    unwrapped.set(anchor, sourceFractions[anchor].clone());
    const queue = [anchor];
    let cursor = 0;
    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      const currentPosition = unwrapped.get(current)!;
      for (const peer of adjacency[current]) {
        if (!members.has(peer) || unwrapped.has(peer)) continue;
        const delta = minimumImageFraction(
          sourceFractions[peer].clone().sub(sourceFractions[current]),
          basis,
          pbc,
        );
        unwrapped.set(peer, currentPosition.clone().add(delta));
        queue.push(peer);
      }
    }
    for (const atom of atoms) {
      if (unwrapped.has(atom)) continue;
      const delta = minimumImageFraction(
        sourceFractions[atom].clone().sub(sourceFractions[anchor]),
        basis,
        pbc,
      );
      unwrapped.set(atom, sourceFractions[anchor].clone().add(delta));
    }
    const centroid = new THREE.Vector3();
    atoms.forEach((atom) => centroid.add(unwrapped.get(atom)!));
    centroid.multiplyScalar(1 / atoms.length);
    const shift = new THREE.Vector3(
      pbc[0] ? Math.floor(centroid.x + 0.5) : 0,
      pbc[1] ? Math.floor(centroid.y + 0.5) : 0,
      pbc[2] ? Math.floor(centroid.z + 0.5) : 0,
    );
    atoms.forEach((atom) => toCartesian(unwrapped.get(atom)!.clone().sub(shift), basis).toArray(result, atom * 3));
  }
  for (let atom = 0; atom < count; atom += 1) {
    if (grouped.has(atom)) continue;
    point.fromArray(source, atom * 3);
    const fractional = toFractional(point, basis);
    if (pbc[0]) fractional.x -= Math.floor(fractional.x + 0.5);
    if (pbc[1]) fractional.y -= Math.floor(fractional.y + 0.5);
    if (pbc[2]) fractional.z -= Math.floor(fractional.z + 0.5);
    toCartesian(fractional, basis).toArray(result, atom * 3);
  }
  return result;
}

function moleculeGroups(
  manifest: Manifest,
  count: number,
  bonds: Array<[number, number]>,
): Array<[number, number[]]> {
  if (bonds.length > 0) return connectedComponents(count, bonds).map((atoms, index) => [index, atoms]);
  return semanticGroups(manifest, count);
}

function wrapPositions(source: Float32Array, count: number, basis: CellBasis | null, pbc: Pbc): Float32Array {
  const result = new Float32Array(source.subarray(0, count * 3));
  if (!basis || !pbc.some(Boolean)) return result;
  const point = new THREE.Vector3();
  for (let index = 0; index < count; index += 1) {
    point.fromArray(source, index * 3);
    const fractional = toFractional(point, basis);
    if (pbc[0]) fractional.x -= Math.floor(fractional.x + 0.5);
    if (pbc[1]) fractional.y -= Math.floor(fractional.y + 0.5);
    if (pbc[2]) fractional.z -= Math.floor(fractional.z + 0.5);
    toCartesian(fractional, basis).toArray(result, index * 3);
  }
  return result;
}

function semanticGroups(manifest: Manifest, count: number): Array<[number, number[]]> {
  if (!manifest.topology.residues?.length || !manifest.topology.atom_residue_index?.length) return [];
  const valid = new Set(manifest.topology.residues.map((residue) => residue.index));
  const groups = new Map<number, number[]>();
  manifest.topology.atom_residue_index.slice(0, count).forEach((residue, atom) => {
    if (!Number.isInteger(residue) || !valid.has(residue)) return;
    const atoms = groups.get(residue) ?? [];
    atoms.push(atom);
    groups.set(residue, atoms);
  });
  return [...groups.entries()].sort(([left], [right]) => left - right);
}

function inferCovalentBonds(
  positions: Float32Array,
  atomicNumbers: number[],
  count: number,
  basis: CellBasis | null,
  pbc: Pbc,
): Array<[number, number]> {
  if (count > 50_000) return [];
  const largest = atomicNumbers.reduce((value, number) => Math.max(value, covalentRadii[number] ?? 0.78), 0.78);
  const cellSize = Math.max(1.4, largest * 2.5);
  const cells = new Map<string, Array<[number, number, number, number]>>();
  const shifts = periodicShifts(basis, pbc, largest * 2 * 1.22);
  if (!shifts || count * shifts.length * 27 > MAX_INFERRED_BOND_CELL_PROBES) return [];
  const result: Array<[number, number]> = [];
  let candidateChecks = 0;
  for (let atom = 0; atom < count; atom += 1) {
    const offset = atom * 3;
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    const nearest = new Map<number, number>();
    for (const shift of shifts) {
      const qx = x + shift.x;
      const qy = y + shift.y;
      const qz = z + shift.z;
      const cx = Math.floor(qx / cellSize);
      const cy = Math.floor(qy / cellSize);
      const cz = Math.floor(qz / cellSize);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dz = -1; dz <= 1; dz += 1) {
            const candidates = cells.get(`${cx + dx}:${cy + dy}:${cz + dz}`) ?? [];
            candidateChecks += candidates.length;
            if (candidateChecks > MAX_INFERRED_BOND_CANDIDATES) return [];
            for (const [peer, px, py, pz] of candidates) {
              const distance = Math.hypot(qx - px, qy - py, qz - pz);
              const previous = nearest.get(peer);
              if (previous === undefined || distance < previous) nearest.set(peer, distance);
            }
          }
        }
      }
    }
    for (const [peer, distance] of nearest) {
      const cutoff = ((covalentRadii[atomicNumbers[atom]] ?? 0.78)
        + (covalentRadii[atomicNumbers[peer]] ?? 0.78)) * 1.22;
      if (distance > 0.2 && distance <= cutoff) {
        result.push([peer, atom]);
        if (result.length > MAX_INFERRED_BONDS) return [];
      }
    }
    const key = `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}:${Math.floor(z / cellSize)}`;
    const bucket = cells.get(key) ?? [];
    bucket.push([atom, x, y, z]);
    cells.set(key, bucket);
  }
  return result;
}

function connectedComponents(count: number, bonds: Array<[number, number]>): number[][] {
  const adjacency = Array.from({ length: count }, () => [] as number[]);
  bonds.forEach(([a, b]) => {
    if (a < 0 || b < 0 || a >= count || b >= count) return;
    adjacency[a].push(b);
    adjacency[b].push(a);
  });
  const seen = new Uint8Array(count);
  const result: number[][] = [];
  for (let atom = 0; atom < count; atom += 1) {
    if (seen[atom]) continue;
    const component: number[] = [];
    const stack = [atom];
    seen[atom] = 1;
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const peer of adjacency[current]) {
        if (seen[peer]) continue;
        seen[peer] = 1;
        stack.push(peer);
      }
    }
    result.push(component);
  }
  return result;
}

function isWaterComposition(atoms: number[], atomicNumbers: number[]): boolean {
  let oxygen = 0;
  let hydrogen = 0;
  let virtual = 0;
  for (const atom of atoms) {
    if (atomicNumbers[atom] === 8) oxygen += 1;
    else if (atomicNumbers[atom] === 1) hydrogen += 1;
    else if (!atomicNumbers[atom]) virtual += 1;
    else return false;
  }
  return oxygen === 1 && hydrogen === 2 && virtual <= 1;
}

function isIsolatedWater(
  component: number[],
  bonds: Array<[number, number]>,
  atomicNumbers: number[],
): boolean {
  const members = new Set(component);
  const oxygen = component.find((atom) => atomicNumbers[atom] === 8);
  if (oxygen === undefined) return false;
  let oxygenHydrogens = 0;
  for (const [a, b] of bonds) {
    if (a === oxygen && members.has(b) && atomicNumbers[b] === 1) oxygenHydrogens += 1;
    else if (b === oxygen && members.has(a) && atomicNumbers[a] === 1) oxygenHydrogens += 1;
  }
  return oxygenHydrogens === 2;
}

function normalizeBonds(input: Manifest["topology"]["bonds"], count: number): Array<[number, number]> {
  if (!input || input.length === 0) return [];
  const result: Array<[number, number]> = [];
  if (typeof input[0] === "number") {
    const flat = input as number[];
    for (let index = 0; index + 1 < flat.length; index += 2) addBond(result, flat[index], flat[index + 1], count);
    return result;
  }
  for (const bond of input as Exclude<(typeof input)[number], number>[]) {
    if (Array.isArray(bond)) addBond(result, bond[0], bond[1], count);
    else addBond(result, bond.a ?? bond.source, bond.b ?? bond.target, count);
  }
  return result;
}

function addBond(result: Array<[number, number]>, a: number | undefined, b: number | undefined, count: number): void {
  if (Number.isInteger(a) && Number.isInteger(b) && a !== b && a! >= 0 && b! >= 0 && a! < count && b! < count) {
    result.push([a!, b!]);
  }
}

function resolveAtomicNumbers(manifest: Manifest, count: number): number[] {
  if (manifest.topology.atomic_numbers?.length) return manifest.topology.atomic_numbers.slice(0, count);
  return Array.from({ length: count }, (_, index) => symbolToNumber[manifest.topology.symbols?.[index] ?? ""] ?? 0);
}

function periodicShifts(basis: CellBasis | null, pbc: Pbc, cutoff: number): THREE.Vector3[] | null {
  if (!basis || !pbc.some(Boolean)) return [new THREE.Vector3()];
  const shifts: THREE.Vector3[] = [];
  const limits = basis.reciprocal.map((vector, axis) => (
    pbc[axis] ? Math.max(1, Math.ceil(vector.length() * cutoff - 1e-12)) : 0
  ));
  if (limits.reduce((count, limit) => count * (limit * 2 + 1), 1) > MAX_INFERRED_BOND_SHIFTS) return null;
  for (let a = -limits[0]; a <= limits[0]; a += 1) {
    for (let b = -limits[1]; b <= limits[1]; b += 1) {
      for (let c = -limits[2]; c <= limits[2]; c += 1) {
        shifts.push(toCartesian(new THREE.Vector3(a, b, c), basis));
      }
    }
  }
  return shifts;
}

function toFractional(point: THREE.Vector3, basis: CellBasis): THREE.Vector3 {
  return new THREE.Vector3(
    point.dot(basis.reciprocal[0]),
    point.dot(basis.reciprocal[1]),
    point.dot(basis.reciprocal[2]),
  );
}

function toCartesian(fractional: THREE.Vector3, basis: CellBasis): THREE.Vector3 {
  return new THREE.Vector3()
    .addScaledVector(basis.vectors[0], fractional.x)
    .addScaledVector(basis.vectors[1], fractional.y)
    .addScaledVector(basis.vectors[2], fractional.z);
}

function minimumImageFraction(delta: THREE.Vector3, basis: CellBasis, pbc: Pbc): THREE.Vector3 {
  const base = delta.clone();
  if (pbc[0]) base.x -= Math.floor(base.x + 0.5);
  if (pbc[1]) base.y -= Math.floor(base.y + 0.5);
  if (pbc[2]) base.z -= Math.floor(base.z + 0.5);
  const axes = ([0, 1, 2] as const).filter((axis) => pbc[axis]);
  if (axes.length === 0) return base;

  const q: THREE.Vector3[] = [];
  const r = Array.from({ length: axes.length }, () => Array(axes.length).fill(0) as number[]);
  axes.forEach((axis, column) => {
    const value = basis.vectors[axis].clone();
    for (let row = 0; row < column; row += 1) {
      r[row][column] = q[row].dot(value);
      value.addScaledVector(q[row], -r[row][column]);
    }
    r[column][column] = value.length();
    q.push(value.multiplyScalar(1 / r[column][column]));
  });

  const target = toCartesian(base, basis).multiplyScalar(-1);
  const y = q.map((vector) => vector.dot(target));
  const current = Array(axes.length).fill(0) as number[];
  for (let row = axes.length - 1; row >= 0; row -= 1) {
    let remainder = y[row];
    for (let column = row + 1; column < axes.length; column += 1) {
      remainder -= r[row][column] * current[column];
    }
    current[row] = Math.round(remainder / r[row][row]);
  }

  let best = [...current];
  let bestDistance = projectedDistance(y, r, best);
  const search = (row: number, partialDistance: number) => {
    if (row < 0) {
      if (partialDistance < bestDistance - 1e-12) {
        best = [...current];
        bestDistance = partialDistance;
      }
      return;
    }
    let remainder = y[row];
    for (let column = row + 1; column < axes.length; column += 1) {
      remainder -= r[row][column] * current[column];
    }
    const remaining = Math.max(0, bestDistance - partialDistance);
    const center = remainder / r[row][row];
    const radius = Math.sqrt(remaining) / r[row][row];
    const low = Math.ceil(center - radius - 1e-10);
    const high = Math.floor(center + radius + 1e-10);
    for (const value of nearestIntegers(center, low, high)) {
      current[row] = value;
      const error = remainder - r[row][row] * value;
      const distance = partialDistance + error * error;
      if (distance <= bestDistance + 1e-12) search(row - 1, distance);
    }
  };
  search(axes.length - 1, 0);

  const result = base.clone();
  axes.forEach((axis, index) => result.setComponent(axis, result.getComponent(axis) + best[index]));
  return result;
}

function projectedDistance(y: number[], r: number[][], values: number[]): number {
  let result = 0;
  for (let row = 0; row < values.length; row += 1) {
    let error = y[row];
    for (let column = row; column < values.length; column += 1) error -= r[row][column] * values[column];
    result += error * error;
  }
  return result;
}

function nearestIntegers(center: number, low: number, high: number): number[] {
  const result: number[] = [];
  const nearest = Math.max(low, Math.min(high, Math.round(center)));
  for (let offset = 0; result.length < high - low + 1; offset += 1) {
    const left = nearest - offset;
    const right = nearest + offset;
    if (left >= low && left <= high) result.push(left);
    if (offset > 0 && right >= low && right <= high) result.push(right);
  }
  return result;
}

function namedBackbone(
  residueIndex: number,
  atoms: number[],
  names: string[],
  atomicNumbers: number[],
): BackboneResidue | null {
  const byName = new Map(atoms.map((atom) => [normalizeAtomName(names[atom]), atom]));
  const n = byName.get("N");
  const ca = byName.get("CA");
  const c = byName.get("C");
  const o = byName.get("O");
  if (n === undefined || ca === undefined || c === undefined || o === undefined) return null;
  if (atomicNumbers[n] !== 7 || atomicNumbers[ca] !== 6 || atomicNumbers[c] !== 6 || atomicNumbers[o] !== 8) return null;
  return { residueIndex, n, ca, c, o };
}

function inferredBackbone(
  residueIndex: number,
  atoms: number[],
  atomicNumbers: number[],
  adjacency: number[][],
): BackboneResidue | null {
  const members = new Set(atoms);
  const candidates = new Map<string, BackboneResidue>();
  for (const n of atoms) {
    if (atomicNumbers[n] !== 7) continue;
    for (const ca of adjacency[n] ?? []) {
      if (!members.has(ca) || atomicNumbers[ca] !== 6) continue;
      for (const c of adjacency[ca] ?? []) {
        if (!members.has(c) || c === n || atomicNumbers[c] !== 6) continue;
        const oxygens = (adjacency[c] ?? [])
          .filter((atom) => members.has(atom) && atomicNumbers[atom] === 8)
          .sort((left, right) => left - right);
        if (oxygens.length === 0) continue;
        candidates.set(`${n}:${ca}:${c}`, { residueIndex, n, ca, c, o: oxygens[0] });
      }
    }
  }
  let choices = [...candidates.values()];
  const peptideLinked = choices.filter(({ c }) => (
    (adjacency[c] ?? []).some((atom) => !members.has(atom) && atomicNumbers[atom] === 7)
  ));
  if (peptideLinked.length > 0) choices = peptideLinked;
  const withoutHydrogen = choices.filter(({ c }) => (
    !(adjacency[c] ?? []).some((atom) => atomicNumbers[atom] === 1)
  ));
  if (withoutHydrogen.length > 0) choices = withoutHydrogen;
  return choices.length === 1 ? choices[0] : null;
}

function bondAdjacency(count: number, bonds: Array<[number, number]>): number[][] {
  const adjacency = Array.from({ length: count }, () => [] as number[]);
  bonds.forEach(([a, b]) => {
    adjacency[a]?.push(b);
    adjacency[b]?.push(a);
  });
  return adjacency;
}

function longestBackboneRun(
  entries: BackboneResidue[],
  bonds: Array<[number, number]>,
): BackboneResidue[] {
  const bonded = new Set(bonds.flatMap(([a, b]) => [`${a}:${b}`, `${b}:${a}`]));
  let best: BackboneResidue[] = [];
  let current: BackboneResidue[] = [];
  for (const entry of entries) {
    const previous = current[current.length - 1];
    const sequential = !previous || entry.residueIndex === previous.residueIndex + 1;
    const connected = !previous || bonds.length === 0 || bonded.has(`${previous.c}:${entry.n}`);
    if (!sequential || !connected) current = [];
    current.push(entry);
    if (current.length > best.length) best = [...current];
  }
  return best.length >= 3 ? best : [];
}

function normalizeAtomName(value: string | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function clampImage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-2, Math.min(2, Math.trunc(value)));
}

function imageDistance(value: CellOffset): number {
  return Math.abs(value[0]) + Math.abs(value[1]) + Math.abs(value[2]);
}

const symbolToNumber: Record<string, number> = {
  H: 1, He: 2, Li: 3, Be: 4, B: 5, C: 6, N: 7, O: 8, F: 9, Ne: 10,
  Na: 11, Mg: 12, Al: 13, Si: 14, P: 15, S: 16, Cl: 17, Ar: 18, K: 19, Ca: 20,
  Sc: 21, Ti: 22, V: 23, Cr: 24, Mn: 25, Fe: 26, Co: 27, Ni: 28, Cu: 29, Zn: 30,
  Ga: 31, Ge: 32, As: 33, Se: 34, Br: 35, Kr: 36, Rb: 37, Sr: 38, Y: 39, Zr: 40,
  Nb: 41, Mo: 42, Tc: 43, Ru: 44, Rh: 45, Pd: 46, Ag: 47, Cd: 48, In: 49, Sn: 50,
  Sb: 51, Te: 52, I: 53, Xe: 54, Cs: 55, Ba: 56, La: 57, Ce: 58, Pr: 59, Nd: 60,
  Pm: 61, Sm: 62, Eu: 63, Gd: 64, Tb: 65, Dy: 66, Ho: 67, Er: 68, Tm: 69, Yb: 70,
  Lu: 71, Hf: 72, Ta: 73, W: 74, Re: 75, Os: 76, Ir: 77, Pt: 78, Au: 79, Hg: 80,
  Tl: 81, Pb: 82, Bi: 83, Po: 84, At: 85, Rn: 86, Fr: 87, Ra: 88, Ac: 89, Th: 90,
  Pa: 91, U: 92, Np: 93, Pu: 94, Am: 95, Cm: 96, Bk: 97, Cf: 98, Es: 99, Fm: 100,
  Md: 101, No: 102, Lr: 103, Rf: 104, Db: 105, Sg: 106, Bh: 107, Hs: 108, Mt: 109,
  Ds: 110, Rg: 111, Cn: 112, Nh: 113, Fl: 114, Mc: 115, Lv: 116, Ts: 117, Og: 118,
};

const covalentRadii: Record<number, number> = {
  1: 0.31, 2: 0.28, 3: 1.28, 4: 0.96, 5: 0.84, 6: 0.76, 7: 0.71, 8: 0.66,
  9: 0.57, 10: 0.58, 11: 1.66, 12: 1.41, 13: 1.21, 14: 1.11, 15: 1.07, 16: 1.05,
  17: 1.02, 18: 1.06, 19: 2.03, 20: 1.76, 21: 1.70, 22: 1.60, 23: 1.53, 24: 1.39,
  25: 1.39, 26: 1.32, 27: 1.26, 28: 1.24, 29: 1.32, 30: 1.22, 31: 1.22, 32: 1.20,
  33: 1.19, 34: 1.20, 35: 1.20, 36: 1.16, 37: 2.20, 38: 1.95, 39: 1.90, 40: 1.75,
  41: 1.64, 42: 1.54, 43: 1.47, 44: 1.46, 45: 1.42, 46: 1.39, 47: 1.45, 48: 1.44,
  49: 1.42, 50: 1.39, 51: 1.39, 52: 1.38, 53: 1.39, 54: 1.40, 55: 2.44, 56: 2.15,
  57: 2.07, 58: 2.04, 59: 2.03, 60: 2.01, 61: 1.99, 62: 1.98, 63: 1.98, 64: 1.96,
  65: 1.94, 66: 1.92, 67: 1.92, 68: 1.89, 69: 1.90, 70: 1.87, 71: 1.87, 72: 1.75,
  73: 1.70, 74: 1.62, 75: 1.51, 76: 1.44, 77: 1.41, 78: 1.36, 79: 1.36, 80: 1.32,
  81: 1.45, 82: 1.46, 83: 1.48, 84: 1.40, 85: 1.50, 86: 1.50, 87: 2.60, 88: 2.21,
  89: 2.15, 90: 2.06, 91: 2.00, 92: 1.96, 93: 1.90, 94: 1.87, 95: 1.80, 96: 1.69,
  97: 1.68, 98: 1.68, 99: 1.65, 100: 1.67, 101: 1.73, 102: 1.76, 103: 1.61,
  104: 1.57, 105: 1.49, 106: 1.43, 107: 1.41, 108: 1.34, 109: 1.29, 110: 1.28,
  111: 1.21, 112: 1.22, 113: 1.36, 114: 1.43, 115: 1.62, 116: 1.75, 117: 1.65, 118: 1.57,
};

const vanDerWaalsRadii: Record<number, number> = {
  1: 1.20, 2: 1.40, 3: 1.82, 4: 1.53, 5: 1.92, 6: 1.70, 7: 1.55, 8: 1.52,
  9: 1.47, 10: 1.54, 11: 2.27, 12: 1.73, 13: 1.84, 14: 2.10, 15: 1.80, 16: 1.80,
  17: 1.75, 18: 1.88, 19: 2.75, 20: 2.31, 21: 2.58, 22: 2.46, 23: 2.42, 24: 2.45,
  25: 2.45, 26: 2.44, 27: 2.40, 28: 2.40, 29: 2.38, 30: 2.39, 31: 2.32, 32: 2.29,
  33: 1.88, 34: 1.82, 35: 1.86, 36: 2.25, 37: 3.21, 38: 2.84, 39: 2.75, 40: 2.52,
  41: 2.56, 42: 2.45, 43: 2.44, 44: 2.46, 45: 2.44, 46: 2.15, 47: 2.53, 48: 2.49,
  49: 2.43, 50: 2.42, 51: 2.47, 52: 1.99, 53: 2.04, 54: 2.06, 55: 3.48, 56: 3.03,
  57: 2.98, 58: 2.88, 59: 2.92, 60: 2.95, 61: 2.90, 62: 2.90, 63: 2.87, 64: 2.83,
  65: 2.79, 66: 2.87, 67: 2.81, 68: 2.83, 69: 2.79, 70: 2.80, 71: 2.74, 72: 2.63,
  73: 2.53, 74: 2.57, 75: 2.49, 76: 2.48, 77: 2.41, 78: 2.29, 79: 2.32, 80: 2.45,
  81: 2.47, 82: 2.60, 83: 2.54,
};

function vanDerWaalsRadius(atomicNumber: number): number {
  return vanDerWaalsRadii[atomicNumber] ?? (covalentRadii[atomicNumber] ?? 0.9) + 0.8;
}
