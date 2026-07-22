import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  chooseTrajectorySeries,
  formatTrajectoryValue,
  frameIndexAtPosition,
  TrajectoryPropertyStrip,
  trajectoryTraceGeometry,
} from "./TrajectoryPropertyStrip";
import type { DisplaySeries } from "./types";

const temperature: DisplaySeries = {
  name: "temperature",
  label: "Temperature",
  unit: "K",
  values: [298, 301, 300],
};

const totalEnergy: DisplaySeries = {
  name: "e_tot",
  label: "Total energy",
  unit: "kJ mol⁻¹",
  values: [-12.5, -12.25, -12.75],
};

describe("trajectory property choice", () => {
  it("prefers an energy signal over secondary thermodynamic metrics", () => {
    expect(chooseTrajectorySeries([temperature, totalEnergy], 1)).toBe(totalEnergy);
  });

  it("skips a preferred metric when it contains no usable samples", () => {
    const emptyEnergy = { ...totalEnergy, values: [null, null, null] };
    expect(chooseTrajectorySeries([emptyEnergy, temperature], 1)).toBe(temperature);
  });

  it("falls back deterministically when every series is empty", () => {
    const empty = { ...temperature, values: [null] };
    expect(chooseTrajectorySeries([empty, { ...empty, name: "pressure" }])).toBe(empty);
    expect(chooseTrajectorySeries([])).toBeNull();
  });
});

describe("trajectory trace geometry", () => {
  it("preserves missing-value gaps instead of connecting across them", () => {
    const geometry = trajectoryTraceGeometry([0, 1, null, 3, 2], 5, 400, 64);
    expect(geometry).toMatchObject({ min: 0, max: 3 });
    expect(geometry.path.match(/M/g)).toHaveLength(2);
    expect(geometry.path).toContain("M0 56L100 40");
    expect(geometry.path).toContain("M300 8L400 24");
  });

  it("centers constant data and handles missing traces", () => {
    expect(trajectoryTraceGeometry([4, 4], 2, 100, 64).path).toBe("M0 32L100 32");
    expect(trajectoryTraceGeometry([null], 1).path).toBe("");
  });

  it("bounds long traces while preserving extrema and gaps", () => {
    const values = Array.from({ length: 100_000 }, (_, index) => Math.sin(index / 200));
    values[25_000] = -100;
    values[50_000] = Number.NaN;
    values[75_000] = 100;

    const geometry = trajectoryTraceGeometry(values, values.length, 1000, 64);
    const commands = geometry.path.match(/[ML]/g) ?? [];

    expect(geometry).toMatchObject({ min: -100, max: 100 });
    expect(geometry.path.match(/M/g)).toHaveLength(2);
    expect(commands.length).toBeLessThanOrEqual(2000);
    expect(geometry.path).toContain(" 8");
    expect(geometry.path).toContain(" 56");
  });
});

describe("trajectory seeking and readout", () => {
  it("maps pointer positions to clamped frame indices", () => {
    expect(frameIndexAtPosition(100, 100, 400, 5)).toBe(0);
    expect(frameIndexAtPosition(300, 100, 400, 5)).toBe(2);
    expect(frameIndexAtPosition(700, 100, 400, 5)).toBe(4);
  });

  it("formats ordinary, very small, and unavailable values", () => {
    expect(formatTrajectoryValue(-12.25123)).toBe("-12.2512");
    expect(formatTrajectoryValue(0.00012)).toBe("1.200e-4");
    expect(formatTrajectoryValue(null)).toBe("—");
  });

  it("renders an accessible slider, metric switcher, value, and unit", () => {
    const html = renderToStaticMarkup(
      <TrajectoryPropertyStrip
        series={[temperature, totalEnergy]}
        frameIndex={1}
        frameCount={3}
        onFrame={() => {}}
      />,
    );

    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuenow="2"');
    expect(html).toContain('aria-valuetext="Frame 2 of 3; Total energy: -12.25 kJ mol⁻¹"');
    expect(html).toContain("Displayed property");
    expect(html).toContain("-12.25");
    expect(html).toContain("kJ mol⁻¹");
  });
});
