import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { proteinCameraComposition } from "./proteinCamera";

function positions(points: readonly [number, number, number][]): Float32Array {
  return new Float32Array(points.flat());
}

function projectionExtent(
  points: readonly THREE.Vector3[],
  axis: THREE.Vector3,
): number {
  const values = points.map((point) => point.dot(axis));
  return Math.max(...values) - Math.min(...values);
}

describe("protein camera composition", () => {
  it("presents the longest trace axis horizontally with visible depth", () => {
    const source = positions([
      [-8, -1.0, -0.5],
      [-5, 1.5, 0.7],
      [-2, -0.8, 1.4],
      [1, 1.2, -1.1],
      [4, -1.4, -0.6],
      [8, 0.7, 0.9],
    ]);
    const composition = proteinCameraComposition(source, [0, 1, 2, 3, 4, 5])!;
    const right = new THREE.Vector3().crossVectors(composition.up, composition.direction).normalize();

    const width = projectionExtent(composition.points, right);
    const height = projectionExtent(composition.points, composition.up);
    expect(width).toBeGreaterThan(height);
    expect(width / height).toBeGreaterThan(1.1);
    expect(width / height).toBeLessThan(1.8);
    expect(composition.direction.length()).toBeCloseTo(1, 8);
    expect(composition.direction.dot(composition.up)).toBeCloseTo(0, 8);
  });

  it("uses only backbone indices when solvent lies far away", () => {
    const source = positions([
      [-2, 0, 0],
      [0, 1, 0],
      [2, 0, 1],
      [500, 500, 500],
    ]);
    const composition = proteinCameraComposition(source, [0, 1, 2])!;

    expect(composition.points).toHaveLength(3);
    expect(composition.center.length()).toBeLessThan(3);
  });

  it("is translation invariant and deterministic", () => {
    const points: [number, number, number][] = [
      [-3, 0, 0],
      [-1, 2, 1],
      [1, -1, 2],
      [3, 0, -1],
    ];
    const translated = points.map(([x, y, z]) => [x + 17, y - 9, z + 4] as [number, number, number]);
    const first = proteinCameraComposition(positions(points), [0, 1, 2, 3])!;
    const second = proteinCameraComposition(positions(translated), [0, 1, 2, 3])!;
    const repeated = proteinCameraComposition(positions(points), [0, 1, 2, 3])!;

    expect(first.direction.distanceTo(second.direction)).toBeLessThan(1e-7);
    expect(first.up.distanceTo(second.up)).toBeLessThan(1e-7);
    expect(first.direction.distanceTo(repeated.direction)).toBeLessThan(1e-12);
    const offset = second.center.clone().sub(first.center);
    expect(offset.x).toBeCloseTo(17, 8);
    expect(offset.y).toBeCloseTo(-9, 8);
    expect(offset.z).toBeCloseTo(4, 8);
  });

  it("rejects incomplete or degenerate traces", () => {
    expect(proteinCameraComposition(positions([[0, 0, 0], [1, 0, 0]]), [0, 1])).toBeNull();
    expect(proteinCameraComposition(positions([[1, 1, 1], [1, 1, 1], [1, 1, 1]]), [0, 1, 2])).toBeNull();
  });

  it("scales cartoon fit padding safely", () => {
    const source = positions([[0, 0, 0], [1, 1, 0], [2, 0, 1]]);

    expect(proteinCameraComposition(source, [0, 1, 2], 1.4)?.radius).toBeCloseTo(1.26);
    expect(proteinCameraComposition(source, [0, 1, 2], Number.NaN)?.radius).toBeCloseTo(0.9);
  });
});
