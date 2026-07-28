import { frameArray } from "./api";
import { atomicNumberForElement, ELEMENT_SYMBOLS } from "./scientificSelection";
import type { FrameData, Manifest } from "./types";

export type CellMatrix = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export type CellParameters = {
  a: number;
  b: number;
  c: number;
  alpha: number;
  beta: number;
  gamma: number;
};

const POSITION_NAMES = ["positions", "position", "coordinates", "coords"] as const;
const CELL_NAMES = ["cell", "cell_vectors", "box"] as const;

export function cellMatrix(frame: FrameData | null): CellMatrix | null {
  const cell = frameArray(frame, [...CELL_NAMES]);
  if (!cell || cell.length < 9) return null;
  return [
    cell[0], cell[1], cell[2],
    cell[3], cell[4], cell[5],
    cell[6], cell[7], cell[8],
  ];
}

export function cellParameters(cell: readonly number[]): CellParameters {
  assertCell(cell);
  const a = length(cell, 0);
  const b = length(cell, 3);
  const c = length(cell, 6);
  return {
    a,
    b,
    c,
    alpha: angle(cell, 3, 6, b, c),
    beta: angle(cell, 0, 6, a, c),
    gamma: angle(cell, 0, 3, a, b),
  };
}

export function cellFromParameters(parameters: CellParameters): CellMatrix {
  const { a, b, c, alpha, beta, gamma } = parameters;
  for (const [label, value] of Object.entries({ a, b, c })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} must be greater than zero`);
    }
  }
  for (const [label, value] of Object.entries({ alpha, beta, gamma })) {
    if (!Number.isFinite(value) || value <= 0 || value >= 180) {
      throw new Error(`${label} must be between 0° and 180°`);
    }
  }
  const alphaRad = degreesToRadians(alpha);
  const betaRad = degreesToRadians(beta);
  const gammaRad = degreesToRadians(gamma);
  const sinGamma = Math.sin(gammaRad);
  if (Math.abs(sinGamma) < 1e-8) throw new Error("γ produces a singular cell");
  const cx = c * Math.cos(betaRad);
  const cy = c * (
    Math.cos(alphaRad) - Math.cos(betaRad) * Math.cos(gammaRad)
  ) / sinGamma;
  const czSquared = c * c - cx * cx - cy * cy;
  if (czSquared <= 1e-10) throw new Error("Cell angles produce zero volume");
  return validateCell([
    a, 0, 0,
    b * Math.cos(gammaRad), b * sinGamma, 0,
    cx, cy, Math.sqrt(czSquared),
  ]);
}

export function validateCell(values: readonly number[]): CellMatrix {
  assertCell(values);
  const cell = [...values.slice(0, 9)] as CellMatrix;
  const determinant = cellDeterminant(cell);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) {
    throw new Error("Cell vectors must define a non-zero volume");
  }
  return cell;
}

export function suggestedCell(frame: FrameData | null, padding = 6): CellMatrix {
  const positions = frameArray(frame, [...POSITION_NAMES]);
  if (!positions || positions.length < 3) {
    return [10, 0, 0, 0, 10, 0, 0, 0, 10];
  }
  const extents = [0, 0, 0];
  for (let offset = 0; offset + 2 < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      extents[axis] = Math.max(extents[axis], Math.abs(positions[offset + axis]));
    }
  }
  const lengths = extents.map((extent) => Math.max(4, extent * 2 + padding));
  return [lengths[0], 0, 0, 0, lengths[1], 0, 0, 0, lengths[2]];
}

export function updateAtomPosition(
  frame: FrameData,
  atom: number,
  position: readonly number[],
): FrameData {
  if (!Number.isInteger(atom) || atom < 0) throw new Error("Atom index is invalid");
  if (position.length < 3 || position.some((value) => !Number.isFinite(value))) {
    throw new Error("Atom coordinates must be finite numbers");
  }
  const entry = findArray(frame, POSITION_NAMES);
  if (!entry || atom * 3 + 2 >= entry.array.length) {
    throw new Error("Atom coordinates are unavailable");
  }
  const next = cloneFrame(frame);
  const positions = new Float32Array(entry.array);
  positions.set(position.slice(0, 3), atom * 3);
  next.arrays.set(entry.name, positions);
  return next;
}

export function updateCell(
  frame: FrameData,
  values: readonly number[],
  pbc: readonly boolean[],
  scaleAtoms: boolean,
): FrameData {
  const cell = validateCell(values);
  if (pbc.length < 3) throw new Error("Periodic axes are invalid");
  const previousCell = cellMatrix(frame);
  let next = cloneFrame(frame);
  const entry = findArray(frame, CELL_NAMES);
  const name = entry?.name ?? "cell";
  next.arrays.set(name, new Float32Array(cell));
  next.header.pbc = [Boolean(pbc[0]), Boolean(pbc[1]), Boolean(pbc[2])];
  if (!entry) {
    next.header.arrays = [
      ...next.header.arrays,
      {
        name,
        dtype: "float32",
        shape: [3, 3],
        byte_offset: 0,
        byte_length: 9 * Float32Array.BYTES_PER_ELEMENT,
        unit: "angstrom",
      },
    ];
  }
  if (scaleAtoms && previousCell) {
    next = scalePositions(next, previousCell, cell);
  }
  return next;
}

export function updateAtomElement(
  manifest: Manifest,
  atom: number,
  element: string,
): Manifest {
  if (!Number.isInteger(atom) || atom < 0 || atom >= manifest.topology.atom_count) {
    throw new Error("Atom index is invalid");
  }
  const atomicNumber = atomicNumberForElement(element);
  if (atomicNumber === null) throw new Error(`Unknown element “${element.trim()}”`);
  const atomicNumbers = Array.from(
    { length: manifest.topology.atom_count },
    (_, index) => manifest.topology.atomic_numbers?.[index]
      ?? atomicNumberForElement(manifest.topology.symbols?.[index] ?? "")
      ?? 0,
  );
  const symbols = Array.from(
    { length: manifest.topology.atom_count },
    (_, index) => manifest.topology.symbols?.[index]
      ?? ELEMENT_SYMBOLS[atomicNumbers[index]]
      ?? "X",
  );
  atomicNumbers[atom] = atomicNumber;
  symbols[atom] = ELEMENT_SYMBOLS[atomicNumber];
  return {
    ...manifest,
    topology: {
      ...manifest.topology,
      atomic_numbers: atomicNumbers,
      symbols,
    },
  };
}

export function frameToExtxyz(manifest: Manifest, frame: FrameData): string {
  const positions = frameArray(frame, [...POSITION_NAMES]);
  if (!positions || positions.length < manifest.topology.atom_count * 3) {
    throw new Error("Atom coordinates are unavailable");
  }
  const cell = cellMatrix(frame);
  const pbc = frame.header.pbc?.length === 3
    ? frame.header.pbc.slice(0, 3).map(Boolean)
    : cell ? [true, true, true] : [false, false, false];
  const metadata = [
    cell ? `Lattice="${cell.map(scientificValue).join(" ")}"` : "",
    "Properties=species:S:1:pos:R:3",
    `pbc="${pbc.map((value) => value ? "T" : "F").join(" ")}"`,
  ].filter(Boolean).join(" ");
  const rows = Array.from({ length: manifest.topology.atom_count }, (_, atom) => {
    const atomicNumber = manifest.topology.atomic_numbers?.[atom] ?? 0;
    const symbol = manifest.topology.symbols?.[atom]
      ?? ELEMENT_SYMBOLS[atomicNumber]
      ?? "X";
    const offset = atom * 3;
    return `${symbol} ${scientificValue(positions[offset])} ${scientificValue(positions[offset + 1])} ${scientificValue(positions[offset + 2])}`;
  });
  return `${manifest.topology.atom_count}\n${metadata}\n${rows.join("\n")}\n`;
}

function scalePositions(
  frame: FrameData,
  previousCell: CellMatrix,
  nextCell: CellMatrix,
): FrameData {
  const entry = findArray(frame, POSITION_NAMES);
  if (!entry) return frame;
  const inverse = reciprocalRows(previousCell);
  const positions = new Float32Array(entry.array.length);
  for (let offset = 0; offset + 2 < entry.array.length; offset += 3) {
    const x = entry.array[offset];
    const y = entry.array[offset + 1];
    const z = entry.array[offset + 2];
    const fa = dot(x, y, z, inverse, 0);
    const fb = dot(x, y, z, inverse, 3);
    const fc = dot(x, y, z, inverse, 6);
    positions[offset] = fa * nextCell[0] + fb * nextCell[3] + fc * nextCell[6];
    positions[offset + 1] = fa * nextCell[1] + fb * nextCell[4] + fc * nextCell[7];
    positions[offset + 2] = fa * nextCell[2] + fb * nextCell[5] + fc * nextCell[8];
  }
  const next = cloneFrame(frame);
  next.arrays.set(entry.name, positions);
  return next;
}

function reciprocalRows(cell: CellMatrix): CellMatrix {
  const determinant = cellDeterminant(cell);
  const a = cell.slice(0, 3);
  const b = cell.slice(3, 6);
  const c = cell.slice(6, 9);
  const first = cross(b, c).map((value) => value / determinant);
  const second = cross(c, a).map((value) => value / determinant);
  const third = cross(a, b).map((value) => value / determinant);
  return [...first, ...second, ...third] as CellMatrix;
}

function cloneFrame(frame: FrameData): FrameData {
  return {
    header: {
      ...frame.header,
      arrays: frame.header.arrays.map((descriptor) => ({
        ...descriptor,
        shape: [...descriptor.shape],
      })),
      pbc: frame.header.pbc ? [...frame.header.pbc] : undefined,
    },
    arrays: new Map(frame.arrays),
  };
}

function findArray(
  frame: FrameData,
  names: readonly string[],
): { name: string; array: Float32Array | Int32Array } | null {
  const normalized = new Set(names.map(normalizeName));
  for (const [name, array] of frame.arrays) {
    if (normalized.has(normalizeName(name))) return { name, array };
  }
  return null;
}

function assertCell(values: readonly number[]): void {
  if (values.length < 9 || values.slice(0, 9).some((value) => !Number.isFinite(value))) {
    throw new Error("Cell requires nine finite vector components");
  }
}

function cellDeterminant(cell: readonly number[]): number {
  return cell[0] * (cell[4] * cell[8] - cell[5] * cell[7])
    - cell[1] * (cell[3] * cell[8] - cell[5] * cell[6])
    + cell[2] * (cell[3] * cell[7] - cell[4] * cell[6]);
}

function length(values: readonly number[], offset: number): number {
  return Math.hypot(values[offset], values[offset + 1], values[offset + 2]);
}

function angle(
  values: readonly number[],
  leftOffset: number,
  rightOffset: number,
  leftLength: number,
  rightLength: number,
): number {
  const cosine = (
    values[leftOffset] * values[rightOffset]
    + values[leftOffset + 1] * values[rightOffset + 1]
    + values[leftOffset + 2] * values[rightOffset + 2]
  ) / (leftLength * rightLength);
  return radiansToDegrees(Math.acos(Math.max(-1, Math.min(1, cosine))));
}

function cross(left: readonly number[], right: readonly number[]): number[] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dot(
  x: number,
  y: number,
  z: number,
  values: readonly number[],
  offset: number,
): number {
  return x * values[offset] + y * values[offset + 1] + z * values[offset + 2];
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function scientificValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const normalized = Math.abs(value) < 1e-12 ? 0 : value;
  return Number(normalized.toPrecision(12)).toString();
}
