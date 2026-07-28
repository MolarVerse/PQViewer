import * as THREE from "three";
import type { CellOffset } from "../types";
import {
  imageTranslation,
  unwrapPointNear,
  type CellBasis,
  type Pbc,
} from "./model";

export const MAX_COORDINATION_CENTERS = 2_048;
export const MAX_COORDINATION_CANDIDATES = 8_192;
export const MAX_COORDINATION_NUMBER = 16;
export const MAX_POLYHEDRON_TRIANGLES = 60_000;

export interface CoordinationPolyhedraInput {
  positions: Float32Array;
  atomicNumbers: readonly number[];
  bonds: ReadonlyArray<readonly [number, number]>;
  basis: CellBasis | null;
  pbc: Pbc;
}

export interface CoordinationPolyhedraOptions {
  centerAtoms?: readonly number[];
  centerAtomicNumbers?: readonly number[];
  images?: readonly CellOffset[];
  containedInCell?: boolean;
  cellCenter?: THREE.Vector3;
  maxCenters?: number;
  maxCoordination?: number;
  maxTriangles?: number;
  colorForCenter?: (
    atomIndex: number,
    atomicNumber: number,
  ) => THREE.ColorRepresentation;
}

export interface CoordinationPolyhedron {
  centerAtom: number;
  coordinationNumber: number;
  ligandAtoms: number[];
  vertices: THREE.Vector3[];
  vertexAtoms: number[];
  triangles: Array<[number, number, number]>;
}

export interface PreparedCoordinationPolyhedraTopology {
  readonly atomCount: number;
  readonly candidates: readonly number[];
  readonly adjacency: ReadonlyMap<number, readonly number[]>;
}

interface FacePlane {
  normal: THREE.Vector3;
  offset: number;
  vertices: Set<number>;
}

interface ProjectedPoint {
  index: number;
  x: number;
  y: number;
}

interface CoordinationNeighbor {
  atom: number;
  point: THREE.Vector3;
  distance: number;
}

interface PreparedTopologyMetadata {
  atomicNumbers: readonly number[];
  bonds: ReadonlyArray<readonly [number, number]>;
  selectionKey: string;
}

const DEFAULT_COLOR = new THREE.Color("#568da3");
const EXCLUDED_AUTO_CENTERS = new Set([
  1, 2, 6, 7, 8, 9, 10, 17, 18, 35, 36, 53, 54, 85, 86,
]);
const PREFERRED_METAL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [21, 30],
  [39, 48],
  [57, 80],
  [89, 112],
];
const EMPTY_NEIGHBORS: readonly number[] = Object.freeze([]);
const preparedTopologyMetadata = new WeakMap<
  PreparedCoordinationPolyhedraTopology,
  PreparedTopologyMetadata
>();

export function prepareCoordinationPolyhedraTopology(
  input: CoordinationPolyhedraInput,
  options: CoordinationPolyhedraOptions = {},
): PreparedCoordinationPolyhedraTopology {
  const atomCount = inputAtomCount(input);
  const explicitCenters = options.centerAtoms !== undefined;
  const atomicNumberFilter = coordinationCenterFilter(options);
  const explicitCandidates = explicitCenters
    ? normalizedAtomIndices(options.centerAtoms ?? [], atomCount)
    : null;
  const explicitCandidateSet = explicitCandidates
    ? new Set(explicitCandidates)
    : null;
  const adjacencySets = new Map<number, Set<number>>();

  const eligible = (atom: number): boolean => {
    if (explicitCandidateSet) return explicitCandidateSet.has(atom);
    const atomicNumber = input.atomicNumbers[atom] ?? 0;
    return isSuitableCoordinationCenter(atomicNumber)
      && (!atomicNumberFilter || atomicNumberFilter.has(atomicNumber));
  };
  const addNeighbor = (center: number, neighbor: number): void => {
    if (!eligible(center)) return;
    let neighbors = adjacencySets.get(center);
    if (!neighbors) {
      neighbors = new Set<number>();
      adjacencySets.set(center, neighbors);
    }
    neighbors.add(neighbor);
  };

  for (const bond of input.bonds) {
    const left = bond[0];
    const right = bond[1];
    if (!validBond(left, right, atomCount)) continue;
    addNeighbor(left, right);
    addNeighbor(right, left);
  }

  const candidates = explicitCandidates
    ?? [...adjacencySets.keys()].sort((left, right) => left - right);
  const adjacency = new Map<number, readonly number[]>();
  for (const [center, neighbors] of adjacencySets) {
    adjacency.set(center, Object.freeze([...neighbors]));
  }
  const topology: PreparedCoordinationPolyhedraTopology = Object.freeze({
    atomCount,
    candidates: Object.freeze(candidates),
    adjacency,
  });
  preparedTopologyMetadata.set(topology, {
    atomicNumbers: input.atomicNumbers,
    bonds: input.bonds,
    selectionKey: coordinationCenterSelectionKey(options, atomCount),
  });
  return topology;
}

export function inferCoordinationPolyhedra(
  input: CoordinationPolyhedraInput,
  options: CoordinationPolyhedraOptions = {},
  topology?: PreparedCoordinationPolyhedraTopology,
): CoordinationPolyhedron[] {
  const atomCount = inputAtomCount(input);
  if (atomCount < 2) return [];

  const maxCenters = boundedInteger(
    options.maxCenters,
    1,
    MAX_COORDINATION_CENTERS,
    MAX_COORDINATION_CENTERS,
  );
  const polyhedra = [...coordinationPolyhedronCandidates(input, options, topology)];
  return spatiallySamplePolyhedra(polyhedra, input.positions, maxCenters);
}

export function hasCoordinationPolyhedra(
  input: CoordinationPolyhedraInput,
  options: CoordinationPolyhedraOptions = {},
  topology?: PreparedCoordinationPolyhedraTopology,
): boolean {
  for (const polyhedron of coordinationPolyhedronCandidates(input, options, topology)) {
    if (polyhedron) return true;
  }
  return false;
}

export function buildCoordinationPolyhedraGeometry(
  input: CoordinationPolyhedraInput,
  options: CoordinationPolyhedraOptions = {},
  topology?: PreparedCoordinationPolyhedraTopology,
): THREE.BufferGeometry | null {
  const polyhedra = inferCoordinationPolyhedra(input, options, topology);
  if (polyhedra.length === 0) return null;

  const images = normalizedImages(options.images);
  const maxTriangles = boundedInteger(
    options.maxTriangles,
    1,
    MAX_POLYHEDRON_TRIANGLES,
    MAX_POLYHEDRON_TRIANGLES,
  );
  const positions: number[] = [];
  const colors: number[] = [];
  const atomIndices: number[] = [];
  const centerAtomIndices: number[] = [];
  const ligandAtomIndices: number[] = [];
  const coordinationNumbers: number[] = [];
  const imageOffsets: number[] = [];
  const polyhedronIndices: number[] = [];
  const edgePositions: number[] = [];
  const color = new THREE.Color();
  let triangleCount = 0;
  let renderedPolyhedra = 0;

  outer:
  for (const image of images) {
    const translation = imageTranslation(image, input.basis);
    for (let polyhedronIndex = 0; polyhedronIndex < polyhedra.length; polyhedronIndex += 1) {
      const polyhedron = polyhedra[polyhedronIndex];
      if (
        options.containedInCell
        && !polyhedronContainedInCell(
          polyhedron,
          translation,
          input,
          options.cellCenter,
        )
      ) continue;
      if (triangleCount + polyhedron.triangles.length > maxTriangles) break outer;
      color.copy(DEFAULT_COLOR);
      const requestedColor = options.colorForCenter?.(
        polyhedron.centerAtom,
        input.atomicNumbers[polyhedron.centerAtom] ?? 0,
      );
      if (requestedColor !== undefined) color.set(requestedColor);

      for (const triangle of polyhedron.triangles) {
        for (const vertexIndex of triangle) {
          polyhedron.vertices[vertexIndex]
            .clone()
            .add(translation)
            .toArray(positions, positions.length);
          colors.push(color.r, color.g, color.b);
          atomIndices.push(polyhedron.centerAtom);
          centerAtomIndices.push(polyhedron.centerAtom);
          ligandAtomIndices.push(polyhedron.vertexAtoms[vertexIndex]);
          coordinationNumbers.push(polyhedron.coordinationNumber);
          imageOffsets.push(image[0], image[1], image[2]);
          polyhedronIndices.push(polyhedronIndex);
        }
        triangleCount += 1;
      }
      for (const [left, right] of polyhedronBoundaryEdges(polyhedron)) {
        polyhedron.vertices[left].clone().add(translation).toArray(edgePositions, edgePositions.length);
        polyhedron.vertices[right].clone().add(translation).toArray(edgePositions, edgePositions.length);
      }
      renderedPolyhedra += 1;
    }
  }

  if (triangleCount === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("atomIndex", new THREE.Float32BufferAttribute(atomIndices, 1));
  geometry.setAttribute("centerAtomIndex", new THREE.Float32BufferAttribute(centerAtomIndices, 1));
  geometry.setAttribute("ligandAtomIndex", new THREE.Float32BufferAttribute(ligandAtomIndices, 1));
  geometry.setAttribute("coordinationNumber", new THREE.Float32BufferAttribute(coordinationNumbers, 1));
  geometry.setAttribute("imageOffset", new THREE.Float32BufferAttribute(imageOffsets, 3));
  geometry.setAttribute("polyhedronIndex", new THREE.Float32BufferAttribute(polyhedronIndices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.polyhedronCount = renderedPolyhedra;
  geometry.userData.triangleCount = triangleCount;
  geometry.userData.edgePositions = new Float32Array(edgePositions);
  return geometry;
}

function polyhedronBoundaryEdges(
  polyhedron: CoordinationPolyhedron,
): Array<[number, number]> {
  const edges = new Map<string, {
    edge: [number, number];
    normals: THREE.Vector3[];
  }>();
  for (const [a, b, c] of polyhedron.triangles) {
    const normal = new THREE.Vector3()
      .subVectors(polyhedron.vertices[b], polyhedron.vertices[a])
      .cross(new THREE.Vector3().subVectors(polyhedron.vertices[c], polyhedron.vertices[a]))
      .normalize();
    for (const [left, right] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const edge: [number, number] = left < right ? [left, right] : [right, left];
      const key = `${edge[0]}:${edge[1]}`;
      const entry = edges.get(key) ?? { edge, normals: [] };
      entry.normals.push(normal);
      edges.set(key, entry);
    }
  }
  const coplanarLimit = Math.cos(THREE.MathUtils.degToRad(18));
  return [...edges.values()]
    .filter(({ normals }) => (
      normals.length === 1
      || normals.some((normal, index) => (
        normals.slice(index + 1).some((peer) => Math.abs(normal.dot(peer)) < coplanarLimit)
      ))
    ))
    .map(({ edge }) => edge);
}

export function isSuitableCoordinationCenter(atomicNumber: number): boolean {
  return Number.isInteger(atomicNumber)
    && atomicNumber > 0
    && atomicNumber <= 118
    && !EXCLUDED_AUTO_CENTERS.has(atomicNumber);
}

export function preferredCoordinationCenterAtomicNumbers(
  input: CoordinationPolyhedraInput,
): number[] {
  const candidates = new Set<number>();
  for (const [left, right] of input.bonds) {
    for (const atom of [left, right]) {
      const atomicNumber = input.atomicNumbers[atom] ?? 0;
      if (isSuitableCoordinationCenter(atomicNumber)) {
        candidates.add(atomicNumber);
      }
    }
  }
  const ordered = [...candidates].sort((left, right) => left - right);
  const preferred = ordered.filter((atomicNumber) => (
    PREFERRED_METAL_RANGES.some(
      ([first, last]) => atomicNumber >= first && atomicNumber <= last,
    )
  ));
  return preferred.length > 0 ? preferred : ordered;
}

function polyhedronContainedInCell(
  polyhedron: CoordinationPolyhedron,
  translation: THREE.Vector3,
  input: CoordinationPolyhedraInput,
  cellCenter: THREE.Vector3 | undefined,
): boolean {
  if (!input.basis || !input.pbc.some(Boolean)) return true;
  const center = (cellCenter ?? new THREE.Vector3()).clone().add(translation);
  const tolerance = 2e-5;
  return polyhedron.vertices.every((vertex) => {
    const relative = vertex.clone().add(translation).sub(center);
    return input.pbc.every((periodic, axis) => (
      !periodic
      || Math.abs(relative.dot(input.basis!.reciprocal[axis])) <= 0.5 + tolerance
    ));
  });
}

function* coordinationPolyhedronCandidates(
  input: CoordinationPolyhedraInput,
  options: CoordinationPolyhedraOptions,
  topology: PreparedCoordinationPolyhedraTopology | undefined,
): Generator<CoordinationPolyhedron> {
  const atomCount = inputAtomCount(input);
  if (atomCount < 2) return;

  const maxCoordination = boundedInteger(
    options.maxCoordination,
    3,
    MAX_COORDINATION_NUMBER,
    12,
  );
  const maxCenters = boundedInteger(
    options.maxCenters,
    1,
    MAX_COORDINATION_CENTERS,
    MAX_COORDINATION_CENTERS,
  );
  const prepared = compatiblePreparedTopology(input, options, topology)
    ?? prepareCoordinationPolyhedraTopology(input, options);
  const explicitCenters = options.centerAtoms !== undefined;
  const atomicNumberFilter = coordinationCenterFilter(options);
  const sampledCandidates = evenlySample(
    prepared.candidates,
    Math.min(MAX_COORDINATION_CANDIDATES, Math.max(maxCenters * 4, maxCenters)),
  );

  for (const centerAtom of sampledCandidates) {
    const neighbors = coordinationShell(
      input,
      centerAtom,
      prepared.adjacency.get(centerAtom) ?? EMPTY_NEIGHBORS,
      maxCoordination,
    );
    if (neighbors.length < 3) continue;
    if (
      atomicNumberFilter
      && !atomicNumberFilter.has(input.atomicNumbers[centerAtom] ?? 0)
    ) continue;
    if (
      !explicitCenters
      && !isSuitableCoordinationCenter(input.atomicNumbers[centerAtom] ?? 0)
    ) continue;
    const polyhedron = coordinationPolyhedron(input, centerAtom, neighbors);
    if (polyhedron) yield polyhedron;
  }
}

function compatiblePreparedTopology(
  input: CoordinationPolyhedraInput,
  options: CoordinationPolyhedraOptions,
  topology: PreparedCoordinationPolyhedraTopology | undefined,
): PreparedCoordinationPolyhedraTopology | null {
  if (!topology) return null;
  const atomCount = inputAtomCount(input);
  const metadata = preparedTopologyMetadata.get(topology);
  if (
    topology.atomCount !== atomCount
    || metadata?.atomicNumbers !== input.atomicNumbers
    || metadata.bonds !== input.bonds
    || metadata.selectionKey !== coordinationCenterSelectionKey(options, atomCount)
  ) return null;
  return topology;
}

function inputAtomCount(input: CoordinationPolyhedraInput): number {
  return Math.min(
    input.atomicNumbers.length,
    Math.floor(input.positions.length / 3),
  );
}

function coordinationCenterFilter(
  options: CoordinationPolyhedraOptions,
): ReadonlySet<number> | null {
  return options.centerAtomicNumbers
    ? new Set(options.centerAtomicNumbers.filter(Number.isInteger))
    : null;
}

function coordinationCenterSelectionKey(
  options: CoordinationPolyhedraOptions,
  atomCount: number,
): string {
  const centers = options.centerAtoms === undefined
    ? "auto"
    : `explicit:${normalizedAtomIndices(options.centerAtoms, atomCount).join(",")}`;
  const filter = coordinationCenterFilter(options);
  const atomicNumbers = filter
    ? [...filter].sort((left, right) => left - right).join(",")
    : "*";
  return `${centers}|${atomicNumbers}`;
}

function validBond(left: number, right: number, atomCount: number): boolean {
  return Number.isInteger(left)
    && Number.isInteger(right)
    && left >= 0
    && right >= 0
    && left < atomCount
    && right < atomCount
    && left !== right;
}

function coordinationPolyhedron(
  input: CoordinationPolyhedraInput,
  centerAtom: number,
  neighbors: CoordinationNeighbor[],
): CoordinationPolyhedron | null {
  const center = pointAt(input.positions, centerAtom);
  if (!finiteVector(center)) return null;
  const ligandAtoms = neighbors.map(({ atom }) => atom);
  const vertices = neighbors.map(({ point }) => point.clone());
  const vertexAtoms = [...ligandAtoms];
  if (vertices.some((point) => !finiteVector(point))) return null;

  if (hasCoincidentPoints(vertices)) return null;
  const triangles = planarCoordinationTriangles(vertices)
    ?? convexHullTriangles(vertices);
  if (!triangles) return null;

  return {
    centerAtom,
    coordinationNumber: neighbors.length,
    ligandAtoms,
    vertices,
    vertexAtoms,
    triangles,
  };
}

function planarCoordinationTriangles(
  points: readonly THREE.Vector3[],
): Array<[number, number, number]> | null {
  if (points.length < 3) return null;
  const scale = pointCloudScale(points);
  if (!Number.isFinite(scale) || scale <= 1e-8) return null;
  const tolerance = Math.max(1e-8, scale * 2e-6);
  let normal: THREE.Vector3 | null = null;
  for (let a = 0; a < points.length - 2 && !normal; a += 1) {
    for (let b = a + 1; b < points.length - 1 && !normal; b += 1) {
      for (let c = b + 1; c < points.length; c += 1) {
        const candidate = new THREE.Vector3()
          .subVectors(points[b], points[a])
          .cross(new THREE.Vector3().subVectors(points[c], points[a]));
        if (candidate.length() > tolerance * tolerance) normal = candidate.normalize();
      }
    }
  }
  if (!normal) return null;
  const offset = -normal.dot(points[0]);
  if (points.some((point) => Math.abs(normal!.dot(point) + offset) > tolerance)) return null;
  const boundary = planarConvexHull(
    points,
    points.map((_, index) => index),
    normal,
    tolerance,
  );
  if (boundary.length !== points.length) return null;
  return Array.from(
    { length: boundary.length - 2 },
    (_, index): [number, number, number] => [
      boundary[0],
      boundary[index + 1],
      boundary[index + 2],
    ],
  );
}

function convexHullTriangles(
  points: readonly THREE.Vector3[],
): Array<[number, number, number]> | null {
  if (points.length < 4) return null;
  const scale = pointCloudScale(points);
  if (!Number.isFinite(scale) || scale <= 1e-8) return null;
  const distanceTolerance = Math.max(1e-8, scale * 1e-6);
  const planeTolerance = Math.max(1e-9, scale * 2e-6);
  if (!hasThreeDimensionalExtent(points, scale)) return null;

  const faces: FacePlane[] = [];
  for (let a = 0; a < points.length - 2; a += 1) {
    for (let b = a + 1; b < points.length - 1; b += 1) {
      for (let c = b + 1; c < points.length; c += 1) {
        const normal = new THREE.Vector3()
          .subVectors(points[b], points[a])
          .cross(new THREE.Vector3().subVectors(points[c], points[a]));
        if (normal.length() <= distanceTolerance * distanceTolerance) continue;
        normal.normalize();
        let offset = -normal.dot(points[a]);
        let positive = false;
        let negative = false;
        for (const point of points) {
          const distance = normal.dot(point) + offset;
          if (distance > planeTolerance) positive = true;
          else if (distance < -planeTolerance) negative = true;
        }
        if (positive && negative) continue;
        if (positive) {
          normal.negate();
          offset *= -1;
        }

        let face = faces.find((candidate) => (
          candidate.normal.dot(normal) > 1 - 1e-5
          && Math.abs(candidate.offset - offset) <= planeTolerance
        ));
        if (!face) {
          face = { normal, offset, vertices: new Set<number>() };
          faces.push(face);
        }
        points.forEach((point, index) => {
          if (Math.abs(face!.normal.dot(point) + face!.offset) <= planeTolerance) {
            face!.vertices.add(index);
          }
        });
      }
    }
  }

  const triangles: Array<[number, number, number]> = [];
  for (const face of faces) {
    const boundary = planarConvexHull(points, [...face.vertices], face.normal, distanceTolerance);
    if (boundary.length < 3) continue;
    for (let index = 1; index < boundary.length - 1; index += 1) {
      triangles.push([boundary[0], boundary[index], boundary[index + 1]]);
    }
  }
  if (triangles.length < 4 || !isClosedHull(points.length, triangles)) return null;

  const volume = hullVolume(points, triangles);
  if (volume <= Math.max(1e-10, scale ** 3 * 1e-7)) return null;
  return triangles;
}

function planarConvexHull(
  points: readonly THREE.Vector3[],
  indices: number[],
  normal: THREE.Vector3,
  tolerance: number,
): number[] {
  if (indices.length < 3) return [];
  const origin = points[indices[0]];
  const u = points[indices[1]].clone().sub(origin).normalize();
  if (u.lengthSq() < 1e-12) return [];
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();
  const projected = indices.map((index) => {
    const relative = points[index].clone().sub(origin);
    return { index, x: relative.dot(u), y: relative.dot(v) };
  }).sort((left, right) => left.x - right.x || left.y - right.y || left.index - right.index);
  const lower: ProjectedPoint[] = [];
  const upper: ProjectedPoint[] = [];
  for (const point of projected) {
    while (
      lower.length >= 2
      && cross2d(lower.at(-2)!, lower.at(-1)!, point) <= tolerance * tolerance
    ) lower.pop();
    lower.push(point);
  }
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const point = projected[index];
    while (
      upper.length >= 2
      && cross2d(upper.at(-2)!, upper.at(-1)!, point) <= tolerance * tolerance
    ) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map((point) => point.index);
}

function isClosedHull(
  pointCount: number,
  triangles: ReadonlyArray<readonly [number, number, number]>,
): boolean {
  const edges = new Map<string, number>();
  const usedVertices = new Set<number>();
  for (const triangle of triangles) {
    usedVertices.add(triangle[0]);
    usedVertices.add(triangle[1]);
    usedVertices.add(triangle[2]);
    for (const [left, right] of [
      [triangle[0], triangle[1]],
      [triangle[1], triangle[2]],
      [triangle[2], triangle[0]],
    ]) {
      const key = left < right ? `${left}:${right}` : `${right}:${left}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return usedVertices.size === pointCount
    && [...edges.values()].every((count) => count === 2);
}

function hullVolume(
  points: readonly THREE.Vector3[],
  triangles: ReadonlyArray<readonly [number, number, number]>,
): number {
  let volume = 0;
  const cross = new THREE.Vector3();
  for (const [a, b, c] of triangles) {
    cross.crossVectors(points[b], points[c]);
    volume += points[a].dot(cross) / 6;
  }
  return Math.abs(volume);
}

function hasThreeDimensionalExtent(
  points: readonly THREE.Vector3[],
  scale: number,
): boolean {
  const threshold = Math.max(1e-10, scale ** 3 * 1e-7);
  for (let a = 0; a < points.length - 3; a += 1) {
    for (let b = a + 1; b < points.length - 2; b += 1) {
      const ab = new THREE.Vector3().subVectors(points[b], points[a]);
      for (let c = b + 1; c < points.length - 1; c += 1) {
        const normal = ab.clone().cross(new THREE.Vector3().subVectors(points[c], points[a]));
        for (let d = c + 1; d < points.length; d += 1) {
          if (
            Math.abs(normal.dot(new THREE.Vector3().subVectors(points[d], points[a])))
            > threshold
          ) return true;
        }
      }
    }
  }
  return false;
}

function hasCoincidentPoints(points: readonly THREE.Vector3[]): boolean {
  const scale = pointCloudScale(points);
  const toleranceSquared = Math.max(1e-16, scale * scale * 1e-12);
  for (let left = 0; left < points.length - 1; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      if (points[left].distanceToSquared(points[right]) <= toleranceSquared) return true;
    }
  }
  return false;
}

function pointCloudScale(points: readonly THREE.Vector3[]): number {
  let maximum = 0;
  for (let left = 0; left < points.length - 1; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      maximum = Math.max(maximum, points[left].distanceTo(points[right]));
    }
  }
  return maximum;
}

function coordinationShell(
  input: CoordinationPolyhedraInput,
  centerAtom: number,
  neighbors: readonly number[],
  maxCoordination: number,
): CoordinationNeighbor[] {
  const center = pointAt(input.positions, centerAtom);
  if (!finiteVector(center)) return [];
  const periodic = Boolean(input.basis && input.pbc.some(Boolean));
  const unique = new Map<string, CoordinationNeighbor>();
  const candidates: CoordinationNeighbor[] = [];
  for (const atom of neighbors) {
    for (const point of periodicNeighborPoints(input, center, atom)) {
      const distance = center.distanceTo(point);
      if (!Number.isFinite(distance) || distance <= 1e-6) continue;
      if (!periodic) {
        candidates.push({ atom, point, distance });
        continue;
      }
      const key = pointKey(point);
      const current = unique.get(key);
      if (!current || atom < current.atom) unique.set(key, { atom, point, distance });
    }
  }
  const ranked = (periodic ? [...unique.values()] : candidates)
    .sort((left, right) => left.distance - right.distance || left.atom - right.atom);
  if (ranked.length === 0) return [];

  const shellLimit = ranked[0].distance * 1.32 + 1e-6;
  return ranked
    .filter(({ distance }) => distance <= shellLimit)
    .slice(0, maxCoordination);
}

function periodicNeighborPoints(
  input: CoordinationPolyhedraInput,
  center: THREE.Vector3,
  atom: number,
): THREE.Vector3[] {
  const nearest = unwrapPointNear(
    center,
    pointAt(input.positions, atom),
    input.basis,
    input.pbc,
  );
  if (!input.basis || !input.pbc.some(Boolean)) return [nearest];
  const result: THREE.Vector3[] = [];
  for (const a of input.pbc[0] ? [-1, 0, 1] : [0]) {
    for (const b of input.pbc[1] ? [-1, 0, 1] : [0]) {
      for (const c of input.pbc[2] ? [-1, 0, 1] : [0]) {
        result.push(
          nearest.clone()
            .addScaledVector(input.basis.vectors[0], a)
            .addScaledVector(input.basis.vectors[1], b)
            .addScaledVector(input.basis.vectors[2], c),
        );
      }
    }
  }
  return result;
}

function pointKey(point: THREE.Vector3): string {
  return `${Math.round(point.x * 1e5)}:${Math.round(point.y * 1e5)}:${Math.round(point.z * 1e5)}`;
}

function normalizedAtomIndices(values: readonly number[], atomCount: number): number[] {
  return [...new Set(values.filter((value) => (
    Number.isInteger(value) && value >= 0 && value < atomCount
  )))].sort((left, right) => left - right);
}

function normalizedImages(images: readonly CellOffset[] | undefined): CellOffset[] {
  const source = images?.length ? images : [[0, 0, 0] as CellOffset];
  const result: CellOffset[] = [];
  const keys = new Set<string>();
  for (const image of source) {
    if (image.length !== 3 || !image.every(Number.isInteger)) continue;
    const normalized: CellOffset = [image[0], image[1], image[2]];
    const key = normalized.join(":");
    if (!keys.has(key)) {
      result.push(normalized);
      keys.add(key);
    }
    if (result.length >= 125) break;
  }
  return result.length ? result : [[0, 0, 0]];
}

function evenlySample<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  return Array.from({ length: limit }, (_, index) => (
    values[Math.floor((index + 0.5) * values.length / limit)]
  ));
}

function spatiallySamplePolyhedra(
  polyhedra: readonly CoordinationPolyhedron[],
  positions: Float32Array,
  limit: number,
): CoordinationPolyhedron[] {
  if (polyhedra.length <= limit) return [...polyhedra];
  if (limit > 128) return evenlySample(polyhedra, limit);

  const points = polyhedra.map(({ centerAtom }) => pointAt(positions, centerAtom));
  const center = new THREE.Box3()
    .setFromPoints(points)
    .getCenter(new THREE.Vector3());
  let first = 0;
  let firstDistance = Infinity;
  points.forEach((point, index) => {
    const distance = point.distanceToSquared(center);
    if (distance < firstDistance) {
      first = index;
      firstDistance = distance;
    }
  });

  const selected = [first];
  const selectedSet = new Set(selected);
  const nearestDistances = points.map((point) => point.distanceToSquared(points[first]));
  while (selected.length < limit) {
    let next = -1;
    let nextDistance = -1;
    for (let index = 0; index < points.length; index += 1) {
      if (selectedSet.has(index)) continue;
      if (nearestDistances[index] > nextDistance) {
        next = index;
        nextDistance = nearestDistances[index];
      }
    }
    if (next < 0) break;
    selected.push(next);
    selectedSet.add(next);
    points.forEach((point, index) => {
      nearestDistances[index] = Math.min(
        nearestDistances[index],
        point.distanceToSquared(points[next]),
      );
    });
  }
  return selected.map((index) => polyhedra[index]);
}

function pointAt(positions: Float32Array, atom: number): THREE.Vector3 {
  return new THREE.Vector3().fromArray(positions, atom * 3);
}

function finiteVector(value: THREE.Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function cross2d(a: ProjectedPoint, b: ProjectedPoint, c: ProjectedPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return THREE.MathUtils.clamp(Math.floor(value!), minimum, maximum);
}
