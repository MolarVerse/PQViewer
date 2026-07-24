import { describe, expect, it } from "vitest";
import {
  buildMeasurementPlotGeometry,
  clientXToPlotX,
  downsampleMeasurementSegments,
  measurementDiscontinuityThreshold,
  measurementPlotLayout,
  nearestFrameForPlotX,
  splitMeasurementSegments,
} from "./MeasurementPlot";

describe("measurement plot geometry", () => {
  it("keeps null values as visible trace gaps", () => {
    const geometry = buildMeasurementPlotGeometry(
      [0, 1, 2, 3, 4],
      [1, 2, null, 4, 5],
      { left: 0, right: 100, top: 0, bottom: 50, maxPoints: 100 },
    );

    expect(geometry.segments).toHaveLength(2);
    expect(geometry.segments.map(({ points }) => points.map(({ frame }) => frame))).toEqual([
      [0, 1],
      [3, 4],
    ]);
    expect(geometry.segments[0].path).toMatch(/^M0 /);
    expect(geometry.segments[1].path).toContain("M75 ");
  });

  it("splits degree traces across the dihedral wrap", () => {
    const segments = splitMeasurementSegments(
      [0, 1, 2, 3],
      [170, 179, -179, -168],
      measurementDiscontinuityThreshold("°"),
    );

    expect(segments.map((segment) => segment.map(({ value }) => value))).toEqual([
      [170, 179],
      [-179, -168],
    ]);
    expect(measurementDiscontinuityThreshold("Å")).toBeUndefined();
  });

  it("pads a constant trace into a finite vertical domain", () => {
    const geometry = buildMeasurementPlotGeometry([0, 1, 2], [1.5, 1.5, 1.5]);

    expect(geometry.yDomain[0]).toBeLessThan(1.5);
    expect(geometry.yDomain[1]).toBeGreaterThan(1.5);
    geometry.segments[0].points.forEach(({ x, y }) => {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    });
  });
});

describe("measurement plot seeking", () => {
  it("maps rendered pixels into the responsive SVG view box", () => {
    expect(clientXToPlotX(20, { left: 20, width: 360 }, 360)).toBe(0);
    expect(clientXToPlotX(200, { left: 20, width: 360 }, 360)).toBe(180);
    expect(clientXToPlotX(380, { left: 20, width: 360 }, 360)).toBe(360);
    expect(clientXToPlotX(10, { left: 0, width: 0 }, 360)).toBeNull();
  });

  it("seeks the nearest irregular axis value", () => {
    const xValues = [0, 0.5, 2, 8];

    expect(nearestFrameForPlotX(0, xValues, 0, 100)).toBe(0);
    expect(nearestFrameForPlotX(26, xValues, 0, 100)).toBe(2);
    expect(nearestFrameForPlotX(100, xValues, 0, 100)).toBe(3);
  });

  it("uses frame position when the axis is constant", () => {
    expect(nearestFrameForPlotX(74, [1, 1, 1, 1, 1], 0, 100)).toBe(3);
  });
});

describe("measurement plot layout", () => {
  it("uses the available width without changing the panel height", () => {
    const mobile = measurementPlotLayout(374, 122);
    const desktop = measurementPlotLayout(760, 130);

    expect(mobile).toEqual({
      width: 374,
      height: 122,
      left: 58,
      right: 358,
      top: 12,
      bottom: 84,
    });
    expect(desktop).toEqual({
      width: 760,
      height: 130,
      left: 64,
      right: 744,
      top: 12,
      bottom: 92,
    });
    expect((mobile.right - mobile.left) / mobile.width).toBeGreaterThanOrEqual(0.8);
    expect((desktop.right - desktop.left) / desktop.width).toBeGreaterThanOrEqual(0.85);
  });

  it("keeps axes and labels inside a short landscape plot", () => {
    const layout = measurementPlotLayout(560, 88);

    expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.bottom).toBeGreaterThan(layout.top);
    expect(layout.bottom + 17).toBeLessThan(layout.height);
    expect(layout.right).toBeLessThan(layout.width);
    expect((layout.bottom - layout.top) / layout.height).toBeGreaterThan(0.6);
  });
});

describe("measurement plot sampling", () => {
  it("caps long traces while preserving endpoints", () => {
    const source = splitMeasurementSegments(
      Array.from({ length: 10_000 }, (_, index) => index),
      Array.from({ length: 10_000 }, (_, index) => Math.sin(index / 30)),
    );
    const sampled = downsampleMeasurementSegments(source, 400);
    const points = sampled.flat();

    expect(points).toHaveLength(400);
    expect(points[0].frame).toBe(0);
    expect(points.at(-1)?.frame).toBe(9_999);
  });

  it("preserves separate segments within the point budget", () => {
    const source = splitMeasurementSegments(
      [0, 1, 2, 3, 4, 5],
      [1, 2, null, 4, null, 6],
    );
    const sampled = downsampleMeasurementSegments(source, 5);

    expect(sampled.map((segment) => segment.map(({ frame }) => frame))).toEqual([
      [0, 1],
      [3],
      [5],
    ]);
  });
});
