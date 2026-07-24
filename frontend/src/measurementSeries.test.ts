import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { DatasetChangedError } from "./api";
import {
  calculateMeasurementComparison,
  calculateMeasurementSeries,
  measurementComparisonPlotData,
  measurementSeriesCsv,
  measurementSeriesPdf,
  measurementSeriesSvg,
  plotShelfCsv,
  plotShelfPdf,
  plotShelfSvg,
} from "./measurementSeries";
import type {
  MeasurementComparisonProgress,
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

  it("keeps trajectory measurements physical in unwrapped display mode", async () => {
    const frame = trajectoryFrame([4.8, 0, 0, -4.8, 0, 0]);
    const result = await calculateMeasurementSeries({
      manifest: trajectoryManifest(1),
      frameCount: 1,
      selections: primaryPair,
      wrap: "unwrapped",
      minimumImage: true,
      signal: new AbortController().signal,
      loadFrame: async () => frame,
    });

    expect(result.values[0]).toBeCloseTo(0.4, 5);
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
      selections: [
        { atom: 0, image: [-1, 0, 0] },
        { atom: 1, image: [0, 0, 0] },
      ],
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
      selections: [
        { atom: 0, image: [0, 0, 0] },
        { atom: 1, image: [1, 0, 0] },
      ],
      wrap: "molecule",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async () => source,
    });

    expect(result.values[0]).toBeCloseTo(0.4, 5);
  });

  it("does not apply a canonical atom-wrap image twice", async () => {
    const source = trajectoryFrame([6, 0, 0, 4, 0, 0]);
    const result = await calculateMeasurementSeries({
      manifest: trajectoryManifest(1),
      frameCount: 1,
      selections: [
        { atom: 0, image: [-1, 0, 0] },
        { atom: 1, image: [0, 0, 0] },
      ],
      wrap: "atom",
      minimumImage: false,
      signal: new AbortController().signal,
      loadFrame: async () => source,
    });

    expect(result.values).toEqual([8]);
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

describe("measurement comparison", () => {
  it("loads each frame once and preserves exact frame identity for every line", async () => {
    const frames = [
      trajectoryFrame([0, 0, 0, 1, 0, 0, 3, 0, 0], { time: 0, timeUnit: "fs" }),
      trajectoryFrame([0, 0, 0, 2, 0, 0, 5, 0, 0], { time: 0.5, timeUnit: "fs" }),
      trajectoryFrame([0, 0, 0, 3, 0, 0, 7, 0, 0], { time: 1, timeUnit: "fs" }),
    ];
    frames[1].arrays.set("positions", new Float32Array([0, 0, 0, 2, 0, 0]));
    frames.forEach((frame, index) => {
      frame.header.frame_key = {
        source_id: "trajectory.extxyz",
        source_index: 40 + index,
        segment_index: 2,
        step: 100 + index * 10,
        time: index * 0.5,
        time_unit: "fs",
      };
    });
    const calls: number[] = [];
    const progress: MeasurementComparisonProgress[] = [];
    const result = await calculateMeasurementComparison({
      manifest: trajectoryManifest(3, [], ["C", "O", "H"]),
      frameCount: 3,
      definitions: [
        {
          id: "co",
          label: "C1–O2",
          selections: primaryPair,
          minimumImage: false,
        },
        {
          id: "ch",
          selections: [
            { atom: 0, image: [0, 0, 0] },
            { atom: 2, image: [0, 0, 0] },
          ],
          minimumImage: false,
        },
      ],
      wrap: "none",
      signal: new AbortController().signal,
      loadFrame: async (index) => {
        calls.push(index);
        return frames[index];
      },
      onProgress: (snapshot) => progress.push(snapshot),
    });

    expect(calls).toEqual([0, 1, 2]);
    expect(result).toMatchObject({
      title: "Measurement comparison",
      unit: "angstrom",
      axis: { kind: "time", label: "Time", unit: "fs" },
      xValues: [0, 0.5, 1],
      frameIndices: [0, 1, 2],
      loadedCount: 3,
      complete: true,
    });
    expect(result.frameKeys.map((key) => key?.source_index)).toEqual([40, 41, 42]);
    expect(result.lines.map(({ id, values }) => [id, values])).toEqual([
      ["co", [1, 2, 3]],
      ["ch", [3, null, 7]],
    ]);
    expect(progress.at(-1)).toBe(result);
    expect(Object.isFrozen(result.frameKeys)).toBe(true);
    expect(Object.isFrozen(result.lines[0].selections)).toBe(true);
  });

  it("keeps gaps aligned across definitions and cancels without another load", async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = calculateMeasurementComparison({
      manifest: trajectoryManifest(5, [], ["C", "O", "H"]),
      frameCount: 5,
      definitions: [
        { id: "co", selections: primaryPair, minimumImage: false },
        {
          id: "ch",
          selections: [
            { atom: 0, image: [0, 0, 0] },
            { atom: 2, image: [0, 0, 0] },
          ],
          minimumImage: false,
        },
      ],
      wrap: "none",
      signal: controller.signal,
      loadFrame: async () => {
        calls += 1;
        controller.abort(new DOMException("Stopped", "AbortError"));
        return trajectoryFrame([0, 0, 0, 1, 0, 0, 2, 0, 0]);
      },
    });

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("rejects mixed units and more than eight definitions before loading", async () => {
    let calls = 0;
    const base = {
      manifest: trajectoryManifest(1, [], ["C", "O", "H"]),
      frameCount: 1,
      wrap: "none" as const,
      signal: new AbortController().signal,
      loadFrame: async () => {
        calls += 1;
        return trajectoryFrame([0, 0, 0, 1, 0, 0, 2, 0, 0]);
      },
    };
    await expect(calculateMeasurementComparison({
      ...base,
      definitions: [
        { id: "distance", selections: primaryPair, minimumImage: false },
        {
          id: "angle",
          selections: [
            ...primaryPair,
            { atom: 2, image: [0, 0, 0] },
          ],
          minimumImage: false,
        },
      ],
    })).rejects.toThrow("same unit");
    await expect(calculateMeasurementComparison({
      ...base,
      definitions: Array.from({ length: 9 }, (_, index) => ({
        id: `line-${index}`,
        selections: primaryPair,
        minimumImage: false,
      })),
    })).rejects.toThrow("one to 8 measurements");
    expect(calls).toBe(0);
  });

  it("keeps eight long comparison traces in one bounded sequential pass", async () => {
    const frameCount = 10_001;
    const source = trajectoryFrame([0, 0, 0, 1, 0, 0]);
    const progress: MeasurementComparisonProgress[] = [];
    let calls = 0;
    let active = 0;
    let peak = 0;
    const result = await calculateMeasurementComparison({
      manifest: trajectoryManifest(frameCount),
      frameCount,
      definitions: Array.from({ length: 8 }, (_, index) => ({
        id: `distance-${index}`,
        selections: primaryPair,
        minimumImage: false,
      })),
      wrap: "none",
      signal: new AbortController().signal,
      loadFrame: async () => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return source;
      },
      onProgress: (snapshot) => progress.push(snapshot),
    });

    expect(calls).toBe(frameCount);
    expect(peak).toBe(1);
    expect(progress.length).toBeLessThanOrEqual(23);
    expect(result.lines).toHaveLength(8);
    expect(result.lines.every(({ values }) => (
      values.length === frameCount
      && values[0] === 1
      && values.at(-1) === 1
    ))).toBe(true);
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

  it("writes a valid vector PDF with exact page dimensions and metadata", async () => {
    const bytes = measurementSeriesPdf(series, { width: 720, height: 432 });
    const pdf = new TextDecoder().decode(bytes);
    const parsed = await PDFDocument.load(bytes);

    expect(pdf.startsWith("%PDF-1.4\n%PQV1\n")).toBe(true);
    expect(pdf.endsWith("%%EOF\n")).toBe(true);
    expect(pdf).toContain("/MediaBox [0 0 720 432]");
    expect(pdf).toContain("/BaseFont /Helvetica");
    expect(pdf).toContain("/BaseFont /Helvetica-Bold");
    expect(pdf).toContain("/Title <FEFF00440069007300740061006E00630065002000B70020004300312013004F0032>");
    expect(pdf).toContain("(Distance \\267 C1\\226O2) Tj");
    expect(pdf).toContain("(Time [fs]) Tj");
    expect(pdf).toContain("(Distance [\\305]) Tj");
    expect(pdf).not.toContain("/Subtype /Image");
    expect(pdf).not.toMatch(/NaN|Infinity/);
    expect(parsed.getPageCount()).toBe(1);
    expect(parsed.getPage(0).getSize()).toEqual({
      width: 720,
      height: 432,
    });

    const startXref = Number(pdf.match(/startxref\n(\d+)\n%%EOF/)?.[1]);
    expect(pdf.slice(startXref)).toMatch(/^xref\n/);
    const xrefRows = pdf.slice(startXref).split("\n").slice(3, 10);
    xrefRows.forEach((row, index) => {
      const offset = Number(row.slice(0, 10));
      expect(pdf.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj\\n`));
    });
  });

  it("keeps PDF trace gaps as separate vector subpaths", () => {
    const pdf = new TextDecoder().decode(measurementSeriesPdf(series));
    const trace = pdf.match(
      /0\.075 0\.498 0\.471 RG\n1\.7 w\n1 J 1 j\n([\s\S]*?)\nS/,
    )?.[1] ?? "";

    expect(trace.match(/ m/g)).toHaveLength(2);
    expect(trace.match(/ l/g)).toBeNull();
    expect(pdf).toMatch(/ c\n/);
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
    const emptyPdf = new TextDecoder().decode(measurementSeriesPdf({
      ...series,
      xValues: [1, 2],
      values: [null, null],
      loadedCount: 2,
    }));
    expect(emptyPdf).toContain("(No valid measurements) Tj");
    expect(() => measurementSeriesPdf(series, { width: 0 })).toThrow(
      "PDF width must be a positive integer",
    );
  });
});

describe("generic plot exports", () => {
  const plot = {
    requestId: 4,
    kind: "comparison" as const,
    title: "Pinned distances",
    xLabel: "Time",
    xUnit: "ps",
    yLabel: "Distance",
    yUnit: "Å",
    context: "3 frames sampled",
    xValues: [0, 0.5, 1],
    frameIndices: [0, 4, 9],
    frameKeys: [
      {
        source_id: "segment-a",
        source_index: 0,
        segment_index: 0,
        step: 0,
        time: 0,
        time_unit: "ps",
      },
      {
        source_id: "segment-a",
        source_index: 4,
        segment_index: 0,
        step: 4,
        time: 0.5,
        time_unit: "ps",
      },
      {
        source_id: "segment-b",
        source_index: 1,
        segment_index: 1,
        step: 9,
        time: 1,
        time_unit: "ps",
      },
    ],
    lines: [
      { id: "a", label: "C1–O2", values: [1, null, 2], color: "#137f78" },
      { id: "b", label: "C1–H3", values: [2, 3, 4], color: "#b35c2e" },
    ],
    loadedCount: 3,
    totalCount: 3,
    complete: true,
  };

  it("writes aligned multi-series CSV with units and gaps", () => {
    expect(plotShelfCsv(plot)).toBe(
      "Frame index,Source,Segment index,Source frame index,Time [ps],C1–O2 [Å],C1–H3 [Å]\n"
      + "0,segment-a,0,0,0,1,2\n"
      + "4,segment-a,0,4,0.5,,3\n"
      + "9,segment-b,1,1,1,2,4\n",
    );
  });

  it("writes standalone multi-series SVG and vector PDF", async () => {
    const svg = plotShelfSvg(plot, { width: 800, height: 500 });
    const pdf = plotShelfPdf(plot, { width: 720, height: 432 });
    const parsed = await PDFDocument.load(pdf);

    expect(svg).toContain("Pinned distances");
    expect(svg).toContain("3 frames sampled");
    expect(svg).toContain("C1–O2");
    expect(svg).toContain('stroke="#137f78"');
    expect(svg).toContain('stroke="#b35c2e"');
    expect(svg.match(/<path d=/g)).toHaveLength(2);
    expect(svg).not.toMatch(/NaN|Infinity/);
    expect(new TextDecoder().decode(pdf)).not.toContain("/Subtype /Image");
    expect(parsed.getPage(0).getSize()).toEqual({ width: 720, height: 432 });
  });

  it("adapts a calculated comparison into a typed plot shelf", () => {
    const comparison = {
      title: "Pinned distances",
      unit: "angstrom" as const,
      axis: { kind: "frame" as const, label: "Frame" },
      xValues: [1, 2],
      frameIndices: [3, 8],
      frameKeys: [null, null],
      lines: [{
        id: "a",
        label: "C1–O2",
        kind: "distance" as const,
        unit: "angstrom" as const,
        selections: primaryPair,
        minimumImage: true,
        values: [1, 2],
      }],
      loadedCount: 2,
      complete: true,
    };
    const adapted = measurementComparisonPlotData(comparison, 12);

    expect(adapted).toMatchObject({
      requestId: 12,
      kind: "measurement",
      yLabel: "Distance",
      yUnit: "Å",
      frameIndices: [3, 8],
      complete: true,
    });
    expect(adapted.lines[0]).toMatchObject({
      id: "a",
      selection: primaryPair,
      minimumImage: true,
    });
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
