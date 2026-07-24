import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildPlotShelfGeometry,
  buildMeasurementPlotGeometry,
  clientXToPlotX,
  downsampleMeasurementSegments,
  exactFrameAt,
  measurementDiscontinuityThreshold,
  measurementPlotLayout,
  nearestFrameForPlotX,
  PlotShelf,
  plotDataIndexForFrame,
  plotShelfYDomain,
  seekableFrameBounds,
  seekablePlotIndices,
  splitMeasurementSegments,
} from "./MeasurementPlot";
import type { PlotShelfData } from "./trajectoryStudy";

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

  it("maps sparse plot points to exact trajectory frames", () => {
    const frames = [0, null, 7, 14];

    expect(plotDataIndexForFrame(7, frames, 4)).toBe(2);
    expect(plotDataIndexForFrame(8, frames, 4)).toBe(-1);
    expect(seekablePlotIndices(frames, 4)).toEqual([0, 2, 3]);
    expect(exactFrameAt(frames, 3)).toBe(14);
    expect(exactFrameAt(frames, 1)).toBeNull();
  });

  it("bounds very long frame maps without spreading them into function arguments", () => {
    const frames = Array.from({ length: 150_000 }, (_, index) => index * 2);
    const indices = seekablePlotIndices(frames, frames.length);

    expect(seekableFrameBounds(frames, indices)).toEqual([0, 299_998]);
    expect(plotDataIndexForFrame(20, frames, frames.length)).toBe(10);
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

  it("shares one y-domain and a bounded DOM budget across eight lines", () => {
    const xValues = Array.from({ length: 10_000 }, (_, index) => index);
    const lines = Array.from({ length: 8 }, (_, line) => ({
      id: `line-${line}`,
      label: `Line ${line}`,
      values: xValues.map((value) => Math.sin(value / 10) + line * 10),
    }));
    const geometry = buildPlotShelfGeometry(xValues, lines, {
      left: 0,
      right: 800,
      top: 0,
      bottom: 120,
      maxPoints: 1_600,
    });
    const renderedPoints = geometry.lines.reduce(
      (total, line) => total + line.segments.reduce(
        (sum, segment) => sum + segment.points.length,
        0,
      ),
      0,
    );

    expect(geometry.lines).toHaveLength(8);
    expect(renderedPoints).toBeLessThanOrEqual(1_600);
    expect(geometry.yDomain[0]).toBeLessThan(0);
    expect(geometry.yDomain[1]).toBeGreaterThan(70);
    expect(geometry.lines.every(({ segments }) => (
      segments.every(({ points }) => points.every(({ y }) => y >= 0 && y <= 120))
    ))).toBe(true);
  });

  it("keeps nonnegative scientific plots on a zero baseline", () => {
    const lines = [{ id: "rdf", label: "g(r)", values: [0, 4, 20] }];
    const yDomain = plotShelfYDomain(lines, 0);
    const geometry = buildPlotShelfGeometry([0, 1, 2], lines, {
      left: 0,
      right: 100,
      top: 0,
      bottom: 50,
      yDomain,
    });

    expect(yDomain[0]).toBe(0);
    expect(geometry.yDomain[0]).toBe(0);
    expect(geometry.yDomain[1]).toBeGreaterThan(20);
  });
});

describe("plot shelf accessibility", () => {
  const plot: PlotShelfData = {
    requestId: 9,
    kind: "comparison",
    title: "Pinned distances",
    xLabel: "Time",
    xUnit: "ps",
    yLabel: "Distance",
    yUnit: "Å",
    xValues: [0, 0.5, 1],
    frameIndices: [2, 7, 12],
    lines: [
      {
        id: "co",
        label: "C1–O2",
        values: [1, 1.5, 2],
        selection: [
          { atom: 0, image: [0, 0, 0] },
          { atom: 1, image: [0, 0, 0] },
        ],
      },
      { id: "ch", label: "C1–H3", values: [2, null, 4] },
    ],
    loadedCount: 3,
    totalCount: 3,
    complete: true,
  };

  it("exposes exact frame and every current series value", () => {
    const markup = renderToStaticMarkup(
      <PlotShelf
        plot={plot}
        currentFrame={7}
        onFrame={() => undefined}
        onRestoreLine={() => undefined}
        onClose={() => undefined}
        headerActions={<button type="button" aria-label="Change plotted property">Property</button>}
        onExportCsv={() => undefined}
        onExportSvg={() => undefined}
        onExportPdf={() => undefined}
      />,
    );

    expect(markup).toContain('role="slider"');
    expect(markup).toContain('aria-valuenow="7"');
    expect(markup).toContain("Frame 8; Time 0.5 ps; C1–O2 1.5 Å; C1–H3 unavailable");
    expect(markup).toContain("Restore C1–O2; current value 1.5 Å");
    expect(markup).toContain('aria-label="C1–H3 current value"');
    expect(markup).toContain('class="measurement-plot__header-actions"');
    expect(markup).toContain('aria-label="Plot controls"');
    expect(markup).toContain('aria-label="Change plotted property"');
    expect(markup).toContain('aria-label="Close plot"');
  });

  it("keeps non-trajectory plots readable without a false seek control", () => {
    const markup = renderToStaticMarkup(
      <PlotShelf
        plot={{ ...plot, kind: "rdf", frameIndices: undefined }}
        onExportCsv={() => undefined}
        onExportSvg={() => undefined}
        onExportPdf={() => undefined}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).not.toContain('role="slider"');
  });
});
