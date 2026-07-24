import { describe, expect, it } from "vitest";
import { DatasetChangedError } from "./api";
import {
  calculateMeasurementSeries,
  measurementSeriesCsv,
  measurementSeriesSvg,
} from "./measurementSeries";
import type {
  MeasurementSeries,
  MeasurementSeriesProgress,
} from "./measurementSeries";
import type {
  AtomSelection,
  FrameData,
  Manifest,
} from "./types";

const cell = new Float32Array([
  10, 0, 0,
  0, 10, 0,
  0, 0, 10,
]);

const primaryPair: AtomSelection[] = [
  { atom: 0, image: [0, 0, 0] },
  { atom: 1, image: [0, 0, 0] },
];

describe("measurement series", () => {
  it("uses exact periodic measurements on the displayed wrapped positions", async () => {
    const frames = [
      trajectoryFrame([4.8, 0, 0, -4.8, 0, 0], { time: 0, step: 10, timeUnit: "fs" }),
      trajectoryFrame([4.7, 0, 0, -4.7, 0, 0], { time: 0.5, step: 20, timeUnit: "fs" }),
    ];

    const minimumImage = await calculateMeasurementSeries({
      manifest: trajectoryManifest(frames.length),
      frameCount: frames.length,
      selections: primaryPair,
      wrap: "atom",
      minimumImage: true,
      signal: new AbortController().signal,
      loadFrame: async (index) => frames[index],
    });
    const displayed = await calculateMeasurementSeries({
      manifest: trajectoryManifest(frames.length),
      frameCount: frames.length,
      selections: primaryPair,
      wrap: "atom",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async (index) => frames[index],
    });

    expect(minimumImage.values[0]).toBeCloseTo(0.4, 5);
    expect(minimumImage.values[1]).toBeCloseTo(0.6, 5);
    expect(displayed.values[0]).toBeCloseTo(9.6, 5);
    expect(displayed.values[1]).toBeCloseTo(9.4, 5);
    expect(minimumImage).toMatchObject({
      title: "Distance · C1–O2",
      kind: "distance",
      unit: "angstrom",
      axis: { kind: "time", label: "Time", unit: "fs" },
      xValues: [0, 0.5],
      loadedCount: 2,
      complete: true,
    });
  });

  it("wraps selected atoms in a centered triclinic cell without preparing the full scene", async () => {
    const triclinic = new Float32Array([
      4, 0, 0,
      1, 3, 0,
      0.5, 0.2, 2,
    ]);
    const frame = trajectoryFrame([
      2.5, 0.3, 0,
      -1.1, 0.3, 0,
    ], { pbc: [true, false, false] });
    frame.arrays.set("cell", triclinic);
    const result = await calculateMeasurementSeries({
      manifest: trajectoryManifest(1),
      frameCount: 1,
      selections: primaryPair,
      wrap: "atom",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async () => frame,
    });

    expect(result.values[0]).toBeCloseTo(0.4, 6);
  });

  it("keeps bonded molecules whole before measuring displayed geometry", async () => {
    const source = trajectoryFrame([4.8, 0, 0, -4.8, 0, 0]);
    const result = await calculateMeasurementSeries({
      manifest: trajectoryManifest(1, [[0, 1]]),
      frameCount: 1,
      selections: primaryPair,
      wrap: "molecule",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async () => source,
    });

    expect(result.values[0]).toBeCloseTo(0.4, 5);
  });

  it("keeps selected periodic replicas distinct", async () => {
    const source = trajectoryFrame([1, 0, 0]);
    const selections: AtomSelection[] = [
      { atom: 0, image: [0, 0, 0] },
      { atom: 0, image: [1, 0, 0] },
    ];
    const manifest = trajectoryManifest(1, [], ["C"]);

    const direct = await calculateMeasurementSeries({
      manifest,
      frameCount: 1,
      selections,
      wrap: "none",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async () => source,
    });
    const periodic = await calculateMeasurementSeries({
      manifest,
      frameCount: 1,
      selections,
      wrap: "none",
      minimumImage: true,
      signal: new AbortController().signal,
      loadFrame: async () => source,
    });

    expect(direct.values).toEqual([10]);
    expect(periodic.values).toEqual([0]);
    expect(direct.title).toBe("Distance · C1–C1 (+a)");
  });

  it("uses each frame cell for displayed periodic replicas", async () => {
    const selections: AtomSelection[] = [
      { atom: 0, image: [0, 0, 0] },
      { atom: 0, image: [1, 0, 0] },
    ];
    const frames = [10, 12].map((length) => {
      const frame = trajectoryFrame([0, 0, 0]);
      frame.arrays.set("cell", new Float32Array([
        length, 0, 0,
        0, 10, 0,
        0, 0, 10,
      ]));
      return frame;
    });
    const result = await calculateMeasurementSeries({
      manifest: trajectoryManifest(2, [], ["C"]),
      frameCount: 2,
      selections,
      wrap: "none",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async (index) => frames[index],
    });

    expect(result.values).toEqual([10, 12]);
  });

  it("leaves a gap when requested minimum-image context is missing", async () => {
    const periodic = trajectoryFrame([4.8, 0, 0, -4.8, 0, 0]);
    const nonperiodic = trajectoryFrame([4.8, 0, 0, -4.8, 0, 0], {
      pbc: [false, false, false],
    });
    nonperiodic.arrays.delete("cell");

    const result = await calculateMeasurementSeries({
      manifest: trajectoryManifest(2),
      frameCount: 2,
      selections: primaryPair,
      wrap: "atom",
      minimumImage: true,
      signal: new AbortController().signal,
      loadFrame: async (index) => index === 0 ? periodic : nonperiodic,
    });

    expect(result.values[0]).toBeCloseTo(0.4, 5);
    expect(result.values[1]).toBeNull();
  });

  it("falls back from incomplete time to step and then to one-based frame", async () => {
    const stepFrames = [
      trajectoryFrame([0, 0, 0, 1, 0, 0], { time: 0, step: 20 }),
      trajectoryFrame([0, 0, 0, 2, 0, 0], { step: 40 }),
    ];
    const frameFrames = [
      trajectoryFrame([0, 0, 0, 1, 0, 0], { time: 0, step: 20 }),
      trajectoryFrame([0, 0, 0, 2, 0, 0], { time: 0, step: 10 }),
    ];

    const byStep = await calculateMeasurementSeries({
      manifest: trajectoryManifest(2),
      frameCount: 2,
      selections: primaryPair,
      wrap: "none",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async (index) => stepFrames[index],
    });
    const byFrame = await calculateMeasurementSeries({
      manifest: trajectoryManifest(2),
      frameCount: 2,
      selections: primaryPair,
      wrap: "none",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async (index) => frameFrames[index],
    });

    expect(byStep.axis).toEqual({ kind: "step", label: "Step" });
    expect(byStep.xValues).toEqual([20, 40]);
    expect(byFrame.axis).toEqual({ kind: "frame", label: "Frame" });
    expect(byFrame.xValues).toEqual([1, 2]);
  });

  it("turns unreadable and invalid frames into null gaps", async () => {
    const frames = [
      trajectoryFrame([0, 0, 0, 1, 0, 0]),
      trajectoryFrame([0, 0, 0]),
      trajectoryFrame([0, 0, 0, 3, 0, 0]),
    ];
    const calls: number[] = [];
    const result = await calculateMeasurementSeries({
      manifest: trajectoryManifest(4),
      frameCount: 4,
      selections: primaryPair,
      wrap: "none",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async (index) => {
        calls.push(index);
        if (index === 2) throw new Error("bad frame");
        return frames[index > 2 ? 2 : index];
      },
    });

    expect(calls).toEqual([0, 1, 2, 3]);
    expect(result.values).toEqual([1, null, null, 3]);
    expect(result.xValues).toEqual([1, 2, 3, 4]);
  });

  it("stops after three consecutive frame-load failures", async () => {
    let calls = 0;
    const promise = calculateMeasurementSeries({
      manifest: trajectoryManifest(100),
      frameCount: 100,
      selections: primaryPair,
      wrap: "none",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async () => {
        calls += 1;
        throw new Error("offline");
      },
    });

    await expect(promise).rejects.toThrow("Trajectory frames could not be loaded");
    expect(calls).toBe(3);
  });

  it("stops immediately when the trajectory generation changes", async () => {
    let calls = 0;
    const promise = calculateMeasurementSeries({
      manifest: trajectoryManifest(2),
      frameCount: 2,
      selections: primaryPair,
      wrap: "none",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async () => {
        calls += 1;
        throw new DatasetChangedError("Trajectory changed. Reload the manifest.");
      },
    });

    await expect(promise).rejects.toBeInstanceOf(DatasetChangedError);
    expect(calls).toBe(1);
  });

  it("loads sequentially and emits throttled immutable progress", async () => {
    const frameCount = 125;
    const progress: MeasurementSeriesProgress[] = [];
    let active = 0;
    let peak = 0;
    const result = await calculateMeasurementSeries({
      manifest: trajectoryManifest(frameCount),
      frameCount,
      selections: primaryPair,
      wrap: "none",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return trajectoryFrame([0, 0, 0, 1, 0, 0]);
      },
      onProgress: (value) => progress.push(value),
    });

    expect(peak).toBe(1);
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.length).toBeLessThanOrEqual(62);
    expect(progress[0]).toMatchObject({ loadedCount: 0, complete: false });
    expect(progress[0].xValues).toHaveLength(frameCount);
    expect(progress[0].values).toHaveLength(frameCount);
    const middle = progress.find((value) => value.loadedCount > 0 && !value.complete);
    expect(middle?.xValues).toHaveLength(frameCount);
    expect(middle?.values).toHaveLength(frameCount);
    expect(middle?.values.slice(middle.loadedCount).every((value) => value === null)).toBe(true);
    expect(progress.at(-1)).toBe(result);
    expect(progress.at(-1)).toMatchObject({ loadedCount: frameCount, complete: true });
    for (const value of progress) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.axis)).toBe(true);
      expect(Object.isFrozen(value.xValues)).toBe(true);
      expect(Object.isFrozen(value.values)).toBe(true);
    }
  });

  it("keeps a 10,001-frame trace sequential and progress-bounded", async () => {
    const frameCount = 10_001;
    const source = trajectoryFrame([0, 0, 0, 1, 0, 0]);
    const progress: MeasurementSeriesProgress[] = [];
    let active = 0;
    let peak = 0;
    const result = await calculateMeasurementSeries({
      manifest: trajectoryManifest(frameCount),
      frameCount,
      selections: primaryPair,
      wrap: "none",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return source;
      },
      onProgress: (value) => progress.push(value),
    });

    expect(peak).toBe(1);
    expect(progress.length).toBeLessThanOrEqual(23);
    expect(progress.every(({ xValues, values }) => (
      xValues.length === frameCount && values.length === frameCount
    ))).toBe(true);
    expect(result).toMatchObject({
      loadedCount: frameCount,
      complete: true,
    });
    expect(result.values[0]).toBe(1);
    expect(result.values.at(-1)).toBe(1);
  });

  it("measures a 100,000-atom system from selected coordinates only", async () => {
    const atomCount = 100_000;
    const positions = new Float32Array(atomCount * 3);
    positions[(atomCount - 1) * 3] = 1;
    const source = trajectoryFrame([]);
    source.arrays.set("positions", positions);
    const result = await calculateMeasurementSeries({
      manifest: {
        ...trajectoryManifest(100),
        topology: {
          atom_count: atomCount,
          bonds: [],
          bond_source: "topology",
        },
      },
      frameCount: 100,
      selections: [
        { atom: 0, image: [0, 0, 0] },
        { atom: atomCount - 1, image: [0, 0, 0] },
      ],
      wrap: "atom",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async () => source,
    });

    expect(result.values).toHaveLength(100);
    expect(result.values.every((value) => value === 1)).toBe(true);
  });

  it("stops promptly when cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = calculateMeasurementSeries({
      manifest: trajectoryManifest(10),
      frameCount: 10,
      selections: primaryPair,
      wrap: "none",
      minimumImage: false,
      signal: controller.signal,
      loadFrame: async () => {
        calls += 1;
        controller.abort(new DOMException("Stopped", "AbortError"));
        return trajectoryFrame([0, 0, 0, 1, 0, 0]);
      },
    });

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("validates the bounded measurement request", async () => {
    const options = {
      manifest: trajectoryManifest(1),
      frameCount: 1,
      selections: [{ atom: 0, image: [0, 0, 0] }] as AtomSelection[],
      wrap: "none" as const,
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async () => trajectoryFrame([0, 0, 0]),
    };

    await expect(calculateMeasurementSeries(options)).rejects.toThrow(
      "two to four selected atoms",
    );
  });
});

describe("measurement series exports", () => {
  const series: MeasurementSeries = Object.freeze({
    title: "Distance · C1–O2",
    kind: "distance",
    unit: "angstrom",
    axis: Object.freeze({ kind: "time", label: "Time", unit: "fs" }),
    xValues: Object.freeze([0, 0.5, 1]),
    values: Object.freeze([1.25, null, 2.5]),
    loadedCount: 3,
    complete: true,
  });

  it("writes a compact CSV with units and empty gap values", () => {
    expect(measurementSeriesCsv(series)).toBe(
      "Time [fs],Distance [Å]\n0,1.25\n0.5,\n1,2.5\n",
    );
    expect(measurementSeriesCsv({
      ...series,
      xValues: [0, 0.5, 1],
      values: [0.39999961853027344, 9.600000381469727, 9.400531518412526],
      loadedCount: 3,
    })).toContain("\n0,0.4\n0.5,9.6\n1,9.40053\n");
  });

  it("writes a standalone publication SVG with disconnected gap segments", () => {
    const svg = measurementSeriesSvg(
      { ...series, title: "Distance · C1 & O2" },
      { width: 800, height: 500 },
    );

    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"');
    expect(svg).toContain("Distance · C1 &amp; O2");
    expect(svg).toContain("Time [fs]");
    expect(svg).toContain("Distance [Å]");
    expect(svg).toMatch(/<path d="M[^"]+M[^"]+"/);
    expect(svg).not.toMatch(/NaN|Infinity/);
  });

  it("does not connect a dihedral trace across the signed-angle boundary", () => {
    const svg = measurementSeriesSvg({
      ...series,
      title: "Dihedral · C1–C2–C3–C4",
      kind: "dihedral",
      unit: "degree",
      xValues: [0, 1, 2, 3],
      values: [170, 179, -179, -168],
      loadedCount: 4,
    });
    const path = svg.match(/<path d="([^"]+)"/)?.[1] ?? "";

    expect(path.match(/M/g)).toHaveLength(2);
    expect(path.match(/L/g)).toHaveLength(2);
  });

  it("renders an explicit empty state and rejects invalid dimensions", () => {
    const empty = measurementSeriesSvg({
      ...series,
      xValues: [1, 2],
      values: [null, null],
      loadedCount: 2,
    });

    expect(empty).toContain("No valid measurements");
    expect(() => measurementSeriesSvg(series, { width: 0 })).toThrow(
      "SVG width must be a positive integer",
    );
  });
});

function trajectoryManifest(
  frameCount: number,
  bonds: Array<[number, number]> = [],
  symbols = ["C", "O"],
): Manifest {
  return {
    schema_version: 1,
    name: "trajectory.extxyz",
    frame_count: frameCount,
    topology: {
      atom_count: symbols.length,
      symbols,
      atomic_numbers: symbols.map((symbol) => symbol === "O" ? 8 : 6),
      bonds,
      bond_source: "topology",
    },
  };
}

function trajectoryFrame(
  positions: number[],
  metadata: {
    time?: number;
    step?: number;
    timeUnit?: string;
    pbc?: boolean[];
  } = {},
): FrameData {
  return {
    header: {
      arrays: [],
      time: metadata.time,
      step: metadata.step,
      scalar_units: metadata.timeUnit ? { time: metadata.timeUnit } : undefined,
      pbc: metadata.pbc ?? [true, true, true],
    },
    arrays: new Map([
      ["positions", new Float32Array(positions)],
      ["cell", cell],
    ]),
  };
}
