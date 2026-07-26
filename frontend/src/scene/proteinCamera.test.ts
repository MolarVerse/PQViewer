import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import {
  proteinCameraComposition,
  type ProteinCameraComposition,
} from "./proteinCamera";

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

function projectionRmsRatio(composition: ProteinCameraComposition): number {
  const mean = composition.points
    .reduce((sum, point) => sum.add(point), new THREE.Vector3())
    .multiplyScalar(1 / composition.points.length);
  const right = new THREE.Vector3()
    .crossVectors(composition.up, composition.direction)
    .normalize();
  let projectedVariance = 0;
  let spatialVariance = 0;
  for (const point of composition.points) {
    const relative = point.clone().sub(mean);
    projectedVariance += relative.dot(right) ** 2 + relative.dot(composition.up) ** 2;
    spatialVariance += relative.lengthSq();
  }
  return Math.sqrt(projectedVariance / spatialVariance);
}

function crambinCaPositions(): Float32Array {
  const lines = readFileSync(
    new URL("../../../docs/assets/sources/1CRN.pdb", import.meta.url),
    "utf8",
  ).split(/\r?\n/);
  const values = lines
    .filter((line) => (
      line.startsWith("ATOM")
      && line.slice(12, 16).trim() === "CA"
    ))
    .flatMap((line) => [
      Number(line.slice(30, 38)),
      Number(line.slice(38, 46)),
      Number(line.slice(46, 54)),
    ]);
  return new Float32Array(values);
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

  it("prefers the broad face of a folded trace", () => {
    const source = positions([
      [-4, -3, 0],
      [-2, 2, 0.1],
      [0, -2, -0.1],
      [2, 3, 0.1],
      [4, -1, 0],
    ]);
    const composition = proteinCameraComposition(source, [0, 1, 2, 3, 4])!;

    expect(projectionRmsRatio(composition)).toBeGreaterThan(0.9);
    expect(Math.abs(composition.direction.z)).toBeGreaterThan(0.85);
  });

  it("keeps structured ribbon faces visible", () => {
    const source = positions([
      [-8, -1.0, -0.5],
      [-5, 1.5, 0.7],
      [-2, -0.8, 1.4],
      [1, 1.2, -1.1],
      [4, -1.4, -0.6],
      [8, 0.7, 0.9],
    ]);
    const indices = [0, 1, 2, 3, 4, 5];
    const baseline = proteinCameraComposition(source, indices)!;
    const faceNormal = baseline.up.clone();
    const composition = proteinCameraComposition(
      source,
      indices,
      1,
      4 / 3,
      indices.map(() => faceNormal),
    )!;

    expect(Math.abs(composition.direction.dot(faceNormal))).toBeGreaterThan(0.35);
  });

  it("frames a straight backbone deterministically", () => {
    const source = positions([
      [-6, -3, 1],
      [-2, -1, 2],
      [2, 1, 3],
      [6, 3, 4],
    ]);
    const indices = [0, 1, 2, 3];
    const first = proteinCameraComposition(source, indices);
    const repeated = proteinCameraComposition(source, indices);
    expect(first).not.toBeNull();
    expect(repeated).not.toBeNull();

    const trace = new THREE.Vector3(4, 2, 1).normalize();
    const right = new THREE.Vector3()
      .crossVectors(first!.up, first!.direction)
      .normalize();
    expect(Math.abs(first!.direction.dot(trace))).toBeLessThan(1e-8);
    expect(Math.abs(right.dot(trace))).toBeCloseTo(1, 8);
    expect(first!.direction.length()).toBeCloseTo(1, 8);
    expect(first!.up.length()).toBeCloseTo(1, 8);
    expect(first!.direction.dot(first!.up)).toBeCloseTo(0, 8);
    expect(first!.direction.distanceTo(repeated!.direction)).toBeLessThan(1e-12);
    expect(first!.up.distanceTo(repeated!.up)).toBeLessThan(1e-12);
  });

  it("shows the face of a straight beta ribbon", () => {
    const source = positions([
      [-6, 0, 0],
      [-2, 0, 0],
      [2, 0, 0],
      [6, 0, 0],
    ]);
    const faceNormal = new THREE.Vector3(0, -1, 0);
    const composition = proteinCameraComposition(
      source,
      [0, 1, 2, 3],
      1,
      4 / 3,
      [faceNormal, faceNormal, faceNormal, faceNormal],
    )!;
    const right = new THREE.Vector3()
      .crossVectors(composition.up, composition.direction)
      .normalize();

    expect(Math.abs(composition.direction.dot(faceNormal))).toBeGreaterThan(0.99);
    expect(Math.abs(right.dot(new THREE.Vector3(1, 0, 0)))).toBeGreaterThan(0.99);
  });

  it("shows the broad fold of 1CRN without foreshortening", () => {
    const source = crambinCaPositions();
    const atomCount = source.length / 3;
    expect(atomCount).toBe(46);
    const composition = proteinCameraComposition(
      source,
      Array.from({ length: atomCount }, (_, index) => index),
    )!;
    const right = new THREE.Vector3()
      .crossVectors(composition.up, composition.direction)
      .normalize();
    const width = projectionExtent(composition.points, right);
    const height = projectionExtent(composition.points, composition.up);
    const depth = projectionExtent(composition.points, composition.direction);

    expect(projectionRmsRatio(composition)).toBeGreaterThan(0.9);
    expect(width / height).toBeGreaterThan(1.1);
    expect(width / height).toBeLessThan(1.7);
    expect(depth).toBeLessThan(width);
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
