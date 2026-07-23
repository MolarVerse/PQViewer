import type { AtomSelection } from "./types";

export type AtomSelectionMode = "replace" | "toggle";

export type MeasurementKind = "distance" | "angle" | "dihedral";

export type MeasurementFailureReason =
  | "selection-size"
  | "duplicate-atoms"
  | "invalid-index"
  | "invalid-position"
  | "invalid-periodic-context"
  | "degenerate-geometry";

export type MeasurementOptions =
  | { mode?: "direct" }
  | {
      mode: "minimum-image";
      cell: ArrayLike<number>;
      pbc: readonly [boolean, boolean, boolean];
    };

export interface MeasurementSuccess {
  ok: true;
  kind: MeasurementKind;
  atomIndices: number[];
  value: number;
  unit: "angstrom" | "degree";
}

export interface MeasurementFailure {
  ok: false;
  atomIndices: number[];
  reason: MeasurementFailureReason;
}

export type MeasurementResult = MeasurementSuccess | MeasurementFailure;

type Vector3 = [number, number, number];

const GEOMETRY_EPSILON = 1e-12;
const CLOSEST_IMAGE_EPSILON = 1e-12;
const MIN_PERIODIC_BASIS_RATIO = 1e-8;
const MAX_CLOSEST_IMAGE_CANDIDATES = 4_096;

interface PeriodicContext {
  vectors: Vector3[];
  q: Vector3[];
  r: number[][];
}

export function updateAtomSelection(
  current: readonly number[],
  atomIndex: number,
  mode: AtomSelectionMode,
): number[] {
  assertSelection(current);
  assertAtomIndex(atomIndex);

  if (mode === "replace") return [atomIndex];
  if (mode !== "toggle") throw new TypeError(`Unknown selection mode: ${String(mode)}`);

  const selectedIndex = current.indexOf(atomIndex);
  if (selectedIndex === -1) return [...current, atomIndex];
  return current.filter((_, index) => index !== selectedIndex);
}

export function updateSceneSelection(
  current: readonly AtomSelection[],
  selection: AtomSelection,
  mode: AtomSelectionMode,
): AtomSelection[] {
  assertSceneSelection(current);
  assertSelectedImage(selection);
  const next = copySelection(selection);
  if (mode === "replace") return [next];
  if (mode !== "toggle") throw new TypeError(`Unknown selection mode: ${String(mode)}`);

  const selectedIndex = current.findIndex((item) => sameSelection(item, selection));
  if (selectedIndex === -1) return [...current.map(copySelection), next];
  return current.filter((_, index) => index !== selectedIndex).map(copySelection);
}

export function selectedAtomPositions(
  positions: ArrayLike<number>,
  selections: readonly AtomSelection[],
  cell: ArrayLike<number> | null,
): Float64Array | null {
  if (!hasValidPositionShape(positions)) return null;
  const needsCell = selections.some(({ image }) => image.some((value) => value !== 0));
  if (needsCell && !hasFiniteCellVectors(cell)) return null;

  const result = new Float64Array(selections.length * 3);
  for (let index = 0; index < selections.length; index += 1) {
    const selection = selections[index];
    if (!validSelectedImage(selection) || selection.atom >= positions.length / 3) return null;
    const point = pointAt(positions, selection.atom);
    if (point === null) return null;
    result.set(point, index * 3);
    if (!cell) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      const image = selection.image[axis];
      result[index * 3] += image * cell[axis * 3];
      result[index * 3 + 1] += image * cell[axis * 3 + 1];
      result[index * 3 + 2] += image * cell[axis * 3 + 2];
    }
  }
  return result;
}

export function measureAtomSelection(
  positions: ArrayLike<number>,
  atomIndices: readonly number[],
  options: MeasurementOptions = {},
): MeasurementResult {
  const selected = [...atomIndices];
  const kind = kindForSelectionSize(selected.length);
  if (kind === null) return failure(selected, "selection-size");
  if (new Set(selected).size !== selected.length) return failure(selected, "duplicate-atoms");
  if (!hasValidPositionShape(positions)) return failure(selected, "invalid-position");

  const points: Vector3[] = [];
  for (const atomIndex of selected) {
    if (!isAtomIndex(atomIndex) || atomIndex >= positions.length / 3) {
      return failure(selected, "invalid-index");
    }
    const point = pointAt(positions, atomIndex);
    if (point === null) return failure(selected, "invalid-position");
    points.push(point);
  }

  const periodic = resolvePeriodicContext(options);
  if (periodic === undefined) return failure(selected, "invalid-periodic-context");
  const displacement = (from: Vector3, to: Vector3) => (
    minimumImageDisplacement(subtract(to, from), periodic)
  );

  if (kind === "distance") {
    const delta = displacement(points[0], points[1]);
    return delta === null
      ? failure(selected, "invalid-periodic-context")
      : success(kind, selected, length(delta), "angstrom");
  }

  if (kind === "angle") {
    const first = displacement(points[1], points[0]);
    const second = displacement(points[1], points[2]);
    if (first === null || second === null) {
      return failure(selected, "invalid-periodic-context");
    }
    const value = angleBetween(first, second);
    return value === null
      ? failure(selected, "degenerate-geometry")
      : success(kind, selected, value, "degree");
  }

  const first = displacement(points[1], points[0]);
  const axis = displacement(points[1], points[2]);
  const last = displacement(points[2], points[3]);
  if (first === null || axis === null || last === null) {
    return failure(selected, "invalid-periodic-context");
  }
  const value = dihedral(first, axis, last);
  return value === null
    ? failure(selected, "degenerate-geometry")
    : success(kind, selected, value, "degree");
}

function kindForSelectionSize(size: number): MeasurementKind | null {
  if (size === 2) return "distance";
  if (size === 3) return "angle";
  if (size === 4) return "dihedral";
  return null;
}

function success(
  kind: MeasurementKind,
  atomIndices: number[],
  value: number,
  unit: MeasurementSuccess["unit"],
): MeasurementSuccess {
  return {
    ok: true,
    kind,
    atomIndices,
    value: Math.abs(value) <= GEOMETRY_EPSILON ? 0 : value,
    unit,
  };
}

function failure(
  atomIndices: number[],
  reason: MeasurementFailureReason,
): MeasurementFailure {
  return { ok: false, atomIndices, reason };
}

function assertSelection(selection: readonly number[]): void {
  const seen = new Set<number>();
  for (const atomIndex of selection) {
    assertAtomIndex(atomIndex);
    if (seen.has(atomIndex)) throw new TypeError("Atom selection contains duplicates");
    seen.add(atomIndex);
  }
}

function assertSceneSelection(selection: readonly AtomSelection[]): void {
  const seen = new Set<string>();
  for (const item of selection) {
    assertSelectedImage(item);
    const key = sceneSelectionKey(item);
    if (seen.has(key)) throw new TypeError("Atom selection contains duplicates");
    seen.add(key);
  }
}

function assertSelectedImage(selection: AtomSelection): void {
  if (!validSelectedImage(selection)) {
    throw new RangeError("Atom selection must contain an atom and integer image");
  }
}

function validSelectedImage(selection: AtomSelection): boolean {
  return isAtomIndex(selection.atom)
    && Array.isArray(selection.image)
    && selection.image.length === 3
    && selection.image.every(Number.isInteger);
}

function sameSelection(left: AtomSelection, right: AtomSelection): boolean {
  return sceneSelectionKey(left) === sceneSelectionKey(right);
}

function sceneSelectionKey(selection: AtomSelection): string {
  return `${selection.atom}:${selection.image[0]}:${selection.image[1]}:${selection.image[2]}`;
}

function copySelection(selection: AtomSelection): AtomSelection {
  return { atom: selection.atom, image: [...selection.image] };
}

function hasFiniteCellVectors(cell: ArrayLike<number> | null): cell is ArrayLike<number> {
  if (!cell || !Number.isInteger(cell.length) || cell.length < 9) return false;
  for (let index = 0; index < 9; index += 1) {
    if (!Number.isFinite(cell[index])) return false;
  }
  return true;
}

function assertAtomIndex(atomIndex: number): void {
  if (!isAtomIndex(atomIndex)) {
    throw new RangeError("Atom index must be a non-negative integer");
  }
}

function isAtomIndex(atomIndex: number): boolean {
  return Number.isInteger(atomIndex) && atomIndex >= 0;
}

function hasValidPositionShape(positions: ArrayLike<number>): boolean {
  return (
    Number.isInteger(positions.length) &&
    positions.length >= 0 &&
    positions.length % 3 === 0
  );
}

function pointAt(positions: ArrayLike<number>, atomIndex: number): Vector3 | null {
  const offset = atomIndex * 3;
  const point: Vector3 = [
    positions[offset],
    positions[offset + 1],
    positions[offset + 2],
  ];
  return point.every(Number.isFinite) ? point : null;
}

function subtract(a: Vector3, b: Vector3): Vector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vector3, b: Vector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(vector: Vector3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function angleBetween(a: Vector3, b: Vector3): number | null {
  const aLength = length(a);
  const bLength = length(b);
  if (aLength <= GEOMETRY_EPSILON || bLength <= GEOMETRY_EPSILON) return null;

  const cosine = dot(a, b) / (aLength * bLength);
  return radiansToDegrees(Math.acos(clamp(cosine, -1, 1)));
}

function dihedral(first: Vector3, axis: Vector3, last: Vector3): number | null {
  const axisLength = length(axis);
  if (axisLength <= GEOMETRY_EPSILON) return null;

  const axisUnit = scale(axis, 1 / axisLength);
  const firstPlane = subtract(first, scale(axisUnit, dot(first, axisUnit)));
  const secondPlane = subtract(last, scale(axisUnit, dot(last, axisUnit)));
  if (
    length(firstPlane) <= GEOMETRY_EPSILON ||
    length(secondPlane) <= GEOMETRY_EPSILON
  ) {
    return null;
  }

  const x = dot(firstPlane, secondPlane);
  const y = dot(cross(axisUnit, firstPlane), secondPlane);
  return radiansToDegrees(Math.atan2(y, x));
}

function resolvePeriodicContext(
  options: MeasurementOptions,
): PeriodicContext | null | undefined {
  if (options.mode !== "minimum-image") return null;
  if (
    options.pbc.length !== 3
    || !options.pbc.every((value) => typeof value === "boolean")
  ) {
    return undefined;
  }
  if (!options.pbc.some(Boolean)) return null;
  if (!Number.isInteger(options.cell.length) || options.cell.length < 9) return undefined;

  const vectors = [
    [options.cell[0], options.cell[1], options.cell[2]],
    [options.cell[3], options.cell[4], options.cell[5]],
    [options.cell[6], options.cell[7], options.cell[8]],
  ] as [Vector3, Vector3, Vector3];
  if (!vectors.flat().every(Number.isFinite)) return undefined;

  const periodicVectors = vectors.filter((_, axis) => options.pbc[axis]);
  const q: Vector3[] = [];
  const r = Array.from({ length: periodicVectors.length }, () => (
    Array(periodicVectors.length).fill(0) as number[]
  ));
  for (let column = 0; column < periodicVectors.length; column += 1) {
    const source = periodicVectors[column];
    const sourceLength = length(source);
    if (!Number.isFinite(sourceLength) || sourceLength <= GEOMETRY_EPSILON) return undefined;
    const value: Vector3 = [...source];
    for (let row = 0; row < column; row += 1) {
      r[row][column] = dot(q[row], value);
      addScaled(value, q[row], -r[row][column]);
    }
    const diagonal = length(value);
    if (
      !Number.isFinite(diagonal)
      || diagonal / sourceLength <= MIN_PERIODIC_BASIS_RATIO
    ) {
      return undefined;
    }
    r[column][column] = diagonal;
    q.push(scale(value, 1 / diagonal));
  }
  return { vectors: periodicVectors, q, r };
}

function minimumImageDisplacement(
  delta: Vector3,
  context: PeriodicContext | null,
): Vector3 | null {
  if (context === null) return delta;

  const target = scale(delta, -1);
  const projectedTarget = context.q.map((vector) => dot(vector, target));
  const current = Array(context.vectors.length).fill(0) as number[];
  let best = [...current];
  let bestDistance = projectedDistance(projectedTarget, context.r, best);

  for (let row = context.vectors.length - 1; row >= 0; row -= 1) {
    let remainder = projectedTarget[row];
    for (let column = row + 1; column < context.vectors.length; column += 1) {
      remainder -= context.r[row][column] * current[column];
    }
    const coefficient = Math.round(remainder / context.r[row][row]);
    if (!Number.isSafeInteger(coefficient)) return null;
    current[row] = coefficient;
  }
  const approximateDistance = projectedDistance(projectedTarget, context.r, current);
  if (!Number.isFinite(approximateDistance)) return null;
  if (strictlyCloser(approximateDistance, bestDistance)) {
    best = [...current];
    bestDistance = approximateDistance;
  }

  let candidates = 0;
  const search = (row: number, partialDistance: number): boolean => {
    if (row < 0) {
      if (strictlyCloser(partialDistance, bestDistance)) {
        best = [...current];
        bestDistance = partialDistance;
      }
      return true;
    }

    let remainder = projectedTarget[row];
    for (let column = row + 1; column < context.vectors.length; column += 1) {
      remainder -= context.r[row][column] * current[column];
    }
    const tolerance = closestImageTolerance(bestDistance);
    const remaining = Math.max(0, bestDistance + tolerance - partialDistance);
    const center = remainder / context.r[row][row];
    const radius = Math.sqrt(remaining) / context.r[row][row];
    if (!Number.isFinite(center) || !Number.isFinite(radius)) return false;
    const low = Math.ceil(center - radius - 1e-10);
    const high = Math.floor(center + radius + 1e-10);
    if (
      !Number.isSafeInteger(low)
      || !Number.isSafeInteger(high)
      || high < low
      || high - low + 1 > MAX_CLOSEST_IMAGE_CANDIDATES - candidates
    ) {
      return false;
    }
    for (const value of nearestIntegers(center, low, high)) {
      candidates += 1;
      if (candidates > MAX_CLOSEST_IMAGE_CANDIDATES) return false;
      current[row] = value;
      const error = remainder - context.r[row][row] * value;
      const distance = partialDistance + error * error;
      if (distance <= bestDistance + tolerance && !search(row - 1, distance)) {
        return false;
      }
    }
    return true;
  };
  if (!search(context.vectors.length - 1, 0)) return null;

  const result: Vector3 = [...delta];
  context.vectors.forEach((vector, index) => addScaled(result, vector, best[index]));
  return result;
}

function projectedDistance(target: number[], r: number[][], values: number[]): number {
  let result = 0;
  for (let row = 0; row < values.length; row += 1) {
    let error = target[row];
    for (let column = row; column < values.length; column += 1) {
      error -= r[row][column] * values[column];
    }
    result += error * error;
  }
  return result;
}

function* nearestIntegers(center: number, low: number, high: number): Generator<number> {
  const nearest = Math.max(low, Math.min(high, Math.round(center)));
  let yielded = 0;
  for (let offset = 0; yielded < high - low + 1; offset += 1) {
    const left = nearest - offset;
    const right = nearest + offset;
    if (left >= low && left <= high) {
      yield left;
      yielded += 1;
    }
    if (offset > 0 && right >= low && right <= high) {
      yield right;
      yielded += 1;
    }
  }
}

function strictlyCloser(candidate: number, current: number): boolean {
  return candidate < current - closestImageTolerance(current);
}

function closestImageTolerance(distance: number): number {
  return CLOSEST_IMAGE_EPSILON * Math.max(1, distance);
}

function addScaled(target: Vector3, vector: Vector3, factor: number): void {
  target[0] += vector[0] * factor;
  target[1] += vector[1] * factor;
  target[2] += vector[2] * factor;
}

function scale(vector: Vector3, factor: number): Vector3 {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}
