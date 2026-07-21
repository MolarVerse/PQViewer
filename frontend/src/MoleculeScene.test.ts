import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { centeredFramePositions, periodicBondSegments } from "./MoleculeScene";
import type { FrameData } from "./types";

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

describe("periodic geometry", () => {
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
  });
});
