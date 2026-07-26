import { describe, expect, it } from "vitest";
import {
  MAX_TRACKED_SELECTIONS,
  trackingFrameIndices,
  trackingFrameMismatch,
  trajectoryOverlaysFromPositions,
} from "./trajectoryTracking";
import type { SelectedPositions } from "./api";
import type { AtomSelection, FrameKey } from "./types";

describe("tracking frame requests", () => {
  it("keeps trails bounded to the current and previous 50 frames", () => {
    const indices = trackingFrameIndices("trail", 1_000, null, 2_000);
    expect(indices).toHaveLength(51);
    expect(indices[0]).toBe(950);
    expect(indices.at(-1)).toBe(1_000);
  });

  it("requests only reference and current frames for displacement", () => {
    expect(trackingFrameIndices("displacement", 80, 4, 100)).toEqual([4, 80]);
    expect(trackingFrameIndices("displacement", 80, null, 100)).toEqual([80]);
  });
});

describe("trajectory overlay data", () => {
  it("rejects preserved references that now point to a different source frame", () => {
    const positions = batch([
      [2, [1, 2, 3]],
      [8, [2.5, 2, 1]],
    ]);

    expect(trackingFrameMismatch(
      positions,
      8,
      frameKey(8),
      2,
      { ...frameKey(2), source_id: "replaced-segment" },
    )).toBe("reference");
    expect(trackingFrameMismatch(
      positions,
      8,
      { ...frameKey(8), source_index: 9 },
      2,
      frameKey(2),
    )).toBe("current");
    expect(trackingFrameMismatch(
      positions,
      8,
      frameKey(8),
      2,
      frameKey(2),
    )).toBeNull();
  });

  it("keeps unwrapped trails continuous and image identity intact", () => {
    const result = trajectoryOverlaysFromPositions(
      batch([
        [0, [4.8, 0, 0]],
        [1, [5.1, 0, 0]],
        [2, [5.4, 0, 0]],
      ]),
      [{ atom: 0, image: [1, 0, 0] }],
      "trail",
      2,
      null,
    );

    expect(result.trails[0].image).toEqual([1, 0, 0]);
    expect(result.trails[0].points).toEqual(
      new Float32Array([4.8, 0, 0, 5.1, 0, 0, 5.4, 0, 0]),
    );
    expect(result.displacements).toEqual([]);
  });

  it("builds exact reference-to-current displacement endpoints", () => {
    const result = trajectoryOverlaysFromPositions(
      batch([
        [2, [1, 2, 3]],
        [8, [2.5, 2, 1]],
      ]),
      [{ atom: 0, image: [0, 0, 0] }],
      "displacement",
      8,
      2,
    );

    expect(result.displacements).toEqual([{
      id: "0:0:0:0",
      atom: 0,
      image: [0, 0, 0],
      from: [1, 2, 3],
      to: [2.5, 2, 1],
    }]);
  });

  it("reports the selected-atom limit instead of truncating", () => {
    const selections: AtomSelection[] = Array.from(
      { length: MAX_TRACKED_SELECTIONS + 1 },
      (_, atom) => ({ atom, image: [0, 0, 0] }),
    );
    expect(() => trajectoryOverlaysFromPositions(
      batch([[0, [0, 0, 0]]]),
      selections,
      "trail",
      0,
      null,
    )).toThrow(`Track up to ${MAX_TRACKED_SELECTIONS}`);
  });
});

function batch(
  frames: Array<[number, [number, number, number]]>,
): SelectedPositions {
  return {
    schemaVersion: 1,
    datasetGeneration: "run",
    atomIndices: [0],
    unit: "angstrom",
    frames: frames.map(([index, coordinates]) => ({
      index,
      key: frameKey(index),
      positions: new Float32Array(coordinates),
      step: index,
      time: index * 0.5,
      timeUnit: "ps",
    })),
  };
}

function frameKey(index: number): FrameKey {
  return {
    source_id: "segment-a",
    source_index: index,
    segment_index: 0,
    step: index,
    time: index * 0.5,
    time_unit: "ps",
  };
}
