export type AtomSelectionMode = "replace" | "toggle";

export type MeasurementKind = "distance" | "angle" | "dihedral";

export type MeasurementFailureReason =
  | "selection-size"
  | "duplicate-atoms"
  | "invalid-index"
  | "invalid-position"
  | "degenerate-geometry";

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

export function measureAtomSelection(
  positions: ArrayLike<number>,
  atomIndices: readonly number[],
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

  if (kind === "distance") {
    return success(kind, selected, length(subtract(points[1], points[0])), "angstrom");
  }

  if (kind === "angle") {
    const first = subtract(points[0], points[1]);
    const second = subtract(points[2], points[1]);
    const value = angleBetween(first, second);
    return value === null
      ? failure(selected, "degenerate-geometry")
      : success(kind, selected, value, "degree");
  }

  const value = dihedral(points[0], points[1], points[2], points[3]);
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
  return { ok: true, kind, atomIndices, value, unit };
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

function dihedral(a: Vector3, b: Vector3, c: Vector3, d: Vector3): number | null {
  const first = subtract(a, b);
  const axis = subtract(c, b);
  const last = subtract(d, c);
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
