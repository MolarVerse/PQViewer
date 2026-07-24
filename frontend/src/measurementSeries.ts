import { DatasetChangedError, frameArray } from "./api";
import {
  createCellBasis,
  prepareScene,
  prepareTopology,
  resolvePbc,
} from "./scene/model";
import {
  measureAtomSelection,
  selectedAtomPositions,
} from "./selection";
import type { MeasurementKind, MeasurementSuccess } from "./selection";
import type {
  AtomSelection,
  FrameData,
  Manifest,
  ScenePresentation,
} from "./types";

export type MeasurementAxisKind = "time" | "step" | "frame";

export interface MeasurementSeriesAxis {
  readonly kind: MeasurementAxisKind;
  readonly label: string;
  readonly unit?: string;
}

export interface MeasurementSeries {
  readonly title: string;
  readonly kind: MeasurementKind;
  readonly unit: MeasurementSuccess["unit"];
  readonly axis: MeasurementSeriesAxis;
  readonly xValues: readonly number[];
  readonly values: readonly (number | null)[];
  readonly loadedCount: number;
  readonly complete: boolean;
}

export type MeasurementSeriesProgress = MeasurementSeries;

export type MeasurementFrameLoader = (
  index: number,
  signal: AbortSignal,
) => Promise<FrameData>;

export interface CalculateMeasurementSeriesOptions {
  manifest: Manifest;
  frameCount: number;
  selections: readonly AtomSelection[];
  wrap: ScenePresentation["wrap"];
  minimumImage: boolean;
  signal: AbortSignal;
  loadFrame: MeasurementFrameLoader;
  onProgress?: (progress: MeasurementSeriesProgress) => void;
}

export interface MeasurementSeriesSvgOptions {
  width?: number;
  height?: number;
}

const MAX_COUNT_PROGRESS_UPDATES = 60;
const MAX_LARGE_COUNT_PROGRESS_UPDATES = 20;

const measurementPresentation: ScenePresentation = {
  mode: "ball-stick",
  water: "show",
  hydrogens: true,
  wrap: "none",
  images: { min: [0, 0, 0], max: [0, 0, 0] },
  cell: false,
  forces: false,
  velocities: false,
  atomScale: 1,
  bondScale: 1,
  color: "element",
  quality: "auto",
};

export async function calculateMeasurementSeries({
  manifest,
  frameCount,
  selections,
  wrap,
  minimumImage,
  signal,
  loadFrame,
  onProgress,
}: CalculateMeasurementSeriesOptions): Promise<MeasurementSeries> {
  validateRequest(manifest, frameCount, selections, wrap);
  throwIfAborted(signal);

  const selected = selections.map(({ atom, image }) => ({
    atom,
    image: [...image] as AtomSelection["image"],
  }));
  const kind = measurementKind(selected.length);
  const unit = measurementUnit(kind);
  const title = measurementTitle(manifest, selected, kind);
  const values = Array<number | null>(frameCount).fill(null);
  const times = Array<number | null>(frameCount).fill(null);
  const steps = Array<number | null>(frameCount).fill(null);
  const frameValues = Object.freeze(oneBasedFrames(frameCount));
  const timeUnits = new Set<string>();
  const presentation = { ...measurementPresentation, wrap };
  let topology: ReturnType<typeof prepareTopology> | undefined;
  let loadedCount = 0;
  let lastProgressCount = 0;
  let consecutiveLoadFailures = 0;
  const maximumProgressUpdates = frameCount >= 10_000
    ? MAX_LARGE_COUNT_PROGRESS_UPDATES
    : MAX_COUNT_PROGRESS_UPDATES;
  const progressStep = Math.max(1, Math.ceil(frameCount / maximumProgressUpdates));

  if (onProgress) {
    onProgress(seriesSnapshot(
      title,
      kind,
      unit,
      frameAxis(),
      frameValues,
      values,
      0,
      false,
    ));
  }

  for (let index = 0; index < frameCount; index += 1) {
    throwIfAborted(signal);
    let frameLoaded = false;
    try {
      const frame = await loadFrame(index, signal);
      frameLoaded = true;
      consecutiveLoadFailures = 0;
      throwIfAborted(signal);
      times[index] = numericMetadata(frame, "time");
      steps[index] = numericMetadata(frame, "step");
      const timeUnit = metadataUnit(frame, "time");
      if (timeUnit) timeUnits.add(timeUnit);

      if (wrap === "molecule") {
        if (topology === undefined) topology = prepareTopology(manifest, frame);
        const scene = prepareScene(manifest, frame, presentation, topology);
        values[index] = scene
          ? measureFrame(frame, scene.positions, scene.pbc, selected, minimumImage, "none")
          : null;
      } else {
        const positions = frameArray(frame, ["positions", "position", "pos", "coordinates", "coords"]);
        const cell = frameArray(frame, ["cell", "cell_vectors", "box"]);
        const basis = createCellBasis(cell);
        values[index] = positions
          ? measureFrame(
              frame,
              positions,
              resolvePbc(frame, basis),
              selected,
              minimumImage,
              wrap,
            )
          : null;
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw abortReason(signal, error);
      if (error instanceof DatasetChangedError) throw error;
      if (!frameLoaded) {
        consecutiveLoadFailures += 1;
        if (consecutiveLoadFailures >= 3) {
          throw new Error("Trajectory frames could not be loaded", { cause: error });
        }
      }
      values[index] = null;
    }

    loadedCount = index + 1;
    if (onProgress && loadedCount < frameCount) {
      if (
        loadedCount === 1
        || loadedCount - lastProgressCount >= progressStep
      ) {
        onProgress(seriesSnapshot(
          title,
          kind,
          unit,
          frameAxis(),
          frameValues,
          values,
          loadedCount,
          false,
        ));
        lastProgressCount = loadedCount;
      }
    }
  }

  throwIfAborted(signal);
  const { axis, xValues } = resolveAxis(times, steps, timeUnits);
  const result = seriesSnapshot(
    title,
    kind,
    unit,
    axis,
    xValues,
    values,
    loadedCount,
    true,
  );
  onProgress?.(result);
  return result;
}

export function measurementSeriesCsv(series: MeasurementSeries): string {
  const xHeader = withUnit(series.axis.label, series.axis.unit);
  const valueHeader = withUnit(titleCase(series.kind), displayUnit(series.unit));
  const rows = [[xHeader, valueHeader]];
  const count = Math.min(series.xValues.length, series.values.length);
  for (let index = 0; index < count; index += 1) {
    rows.push([
      csvNumber(series.xValues[index], 15),
      csvNumber(series.values[index], 6),
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function measurementSeriesSvg(
  series: MeasurementSeries,
  options: MeasurementSeriesSvgOptions = {},
): string {
  const width = positiveDimension(options.width ?? 1200, "width");
  const height = positiveDimension(options.height ?? 720, "height");
  const margin = {
    top: 78,
    right: 48,
    bottom: 86,
    left: 96,
  };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);
  const points = finiteSeriesPoints(series);
  const xDomain = expandedDomain(points.map(({ x }) => x));
  const yDomain = expandedDomain(points.map(({ y }) => y));
  const xMap = (value: number) => (
    margin.left + (value - xDomain[0]) / (xDomain[1] - xDomain[0]) * plotWidth
  );
  const yMap = (value: number) => (
    margin.top + (1 - (value - yDomain[0]) / (yDomain[1] - yDomain[0])) * plotHeight
  );
  const xTicks = ticks(xDomain[0], xDomain[1], 5);
  const yTicks = ticks(yDomain[0], yDomain[1], 5);
  const path = svgPath(series, xMap, yMap);
  const markers = isolatedSvgMarkers(series, xMap, yMap);
  const xLabel = withUnit(series.axis.label, series.axis.unit);
  const yLabel = withUnit(titleCase(series.kind), displayUnit(series.unit));
  const status = series.complete
    ? `${series.values.filter((value) => value !== null).length} valid frames`
    : `${series.loadedCount} frames loaded`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">`,
    "<title id=\"title\">", escapeXml(series.title), "</title>",
    "<desc id=\"description\">", escapeXml(`${series.title}; ${status}.`), "</desc>",
    "<rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>",
    `<text x="${margin.left}" y="38" fill="#172321" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="600">${escapeXml(series.title)}</text>`,
    `<text x="${margin.left}" y="60" fill="#64706d" font-family="Arial, Helvetica, sans-serif" font-size="13">${escapeXml(status)}</text>`,
    ...yTicks.flatMap((value) => {
      const y = plotNumber(yMap(value));
      return [
        `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e2e8e6" stroke-width="1"/>`,
        `<text x="${margin.left - 14}" y="${y}" dy="0.35em" text-anchor="end" fill="#596663" font-family="Arial, Helvetica, sans-serif" font-size="12">${escapeXml(tickNumber(value))}</text>`,
      ];
    }),
    ...xTicks.flatMap((value) => {
      const x = plotNumber(xMap(value));
      return [
        `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${height - margin.bottom}" stroke="#edf1f0" stroke-width="1"/>`,
        `<text x="${x}" y="${height - margin.bottom + 26}" text-anchor="middle" fill="#596663" font-family="Arial, Helvetica, sans-serif" font-size="12">${escapeXml(tickNumber(value))}</text>`,
      ];
    }),
    `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#84908d" stroke-width="1.2"/>`,
    `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#84908d" stroke-width="1.2"/>`,
    path
      ? `<path d="${path}" fill="none" stroke="#137f78" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<text x="${margin.left + plotWidth / 2}" y="${margin.top + plotHeight / 2}" text-anchor="middle" fill="#7b8784" font-family="Arial, Helvetica, sans-serif" font-size="14">No valid measurements</text>`,
    markers,
    `<text x="${margin.left + plotWidth / 2}" y="${height - 24}" text-anchor="middle" fill="#293633" font-family="Arial, Helvetica, sans-serif" font-size="14">${escapeXml(xLabel)}</text>`,
    `<text x="24" y="${margin.top + plotHeight / 2}" transform="rotate(-90 24 ${margin.top + plotHeight / 2})" text-anchor="middle" fill="#293633" font-family="Arial, Helvetica, sans-serif" font-size="14">${escapeXml(yLabel)}</text>`,
    "</svg>",
  ].join("");
}

function measureFrame(
  frame: FrameData,
  positions: Float32Array,
  fallbackPbc: readonly [boolean, boolean, boolean],
  selections: readonly AtomSelection[],
  minimumImage: boolean,
  wrap: "atom" | "none",
): number | null {
  const cell = frameArray(frame, ["cell", "cell_vectors", "box"]);
  const basis = createCellBasis(cell);
  const pbc = framePbc(frame, fallbackPbc);
  const selectedPositions = wrap === "atom" && basis
    ? selectedWrappedAtomPositions(positions, selections, basis, pbc)
    : selectedAtomPositions(positions, selections, basis ? cell : null);
  if (!selectedPositions) return null;
  const indices = selections.map((_, index) => index);
  if (minimumImage && (!cell || !pbc.some(Boolean))) return null;
  const result = minimumImage
    ? measureAtomSelection(selectedPositions, indices, {
        mode: "minimum-image",
        cell: cell!,
        pbc,
      })
    : measureAtomSelection(selectedPositions, indices);
  return result.ok && Number.isFinite(result.value) ? result.value : null;
}

function selectedWrappedAtomPositions(
  source: Float32Array,
  selections: readonly AtomSelection[],
  basis: NonNullable<ReturnType<typeof createCellBasis>>,
  pbc: readonly [boolean, boolean, boolean],
): Float64Array | null {
  const result = new Float64Array(selections.length * 3);
  for (let index = 0; index < selections.length; index += 1) {
    const selection = selections[index];
    const offset = selection.atom * 3;
    if (
      !Number.isInteger(selection.atom)
      || selection.atom < 0
      || offset + 2 >= source.length
      || selection.image.length !== 3
      || !selection.image.every(Number.isInteger)
    ) {
      return null;
    }
    const x = source[offset];
    const y = source[offset + 1];
    const z = source[offset + 2];
    if (![x, y, z].every(Number.isFinite)) return null;
    const fractional = [
      x * basis.reciprocal[0].x + y * basis.reciprocal[0].y + z * basis.reciprocal[0].z,
      x * basis.reciprocal[1].x + y * basis.reciprocal[1].y + z * basis.reciprocal[1].z,
      x * basis.reciprocal[2].x + y * basis.reciprocal[2].y + z * basis.reciprocal[2].z,
    ];
    for (let axis = 0; axis < 3; axis += 1) {
      if (pbc[axis]) fractional[axis] -= Math.floor(fractional[axis] + 0.5);
      fractional[axis] += selection.image[axis];
    }
    result[index * 3] = fractional[0] * basis.vectors[0].x
      + fractional[1] * basis.vectors[1].x
      + fractional[2] * basis.vectors[2].x;
    result[index * 3 + 1] = fractional[0] * basis.vectors[0].y
      + fractional[1] * basis.vectors[1].y
      + fractional[2] * basis.vectors[2].y;
    result[index * 3 + 2] = fractional[0] * basis.vectors[0].z
      + fractional[1] * basis.vectors[1].z
      + fractional[2] * basis.vectors[2].z;
  }
  return result;
}

function framePbc(
  frame: FrameData,
  fallback: readonly [boolean, boolean, boolean],
): [boolean, boolean, boolean] {
  const pbc = frame.header.pbc;
  if (Array.isArray(pbc) && pbc.length === 3) {
    return [Boolean(pbc[0]), Boolean(pbc[1]), Boolean(pbc[2])];
  }
  return [fallback[0], fallback[1], fallback[2]];
}

function resolveAxis(
  times: readonly (number | null)[],
  steps: readonly (number | null)[],
  timeUnits: ReadonlySet<string>,
): { axis: MeasurementSeriesAxis; xValues: number[] } {
  if (usableAxis(times) && timeUnits.size <= 1) {
    const unit = [...timeUnits][0];
    return {
      axis: unit
        ? { kind: "time", label: "Time", unit }
        : { kind: "time", label: "Time" },
      xValues: times as number[],
    };
  }
  if (usableAxis(steps)) {
    return {
      axis: { kind: "step", label: "Step" },
      xValues: steps as number[],
    };
  }
  return {
    axis: frameAxis(),
    xValues: oneBasedFrames(times.length),
  };
}

function usableAxis(values: readonly (number | null)[]): values is readonly number[] {
  if (values.length < 2 || values.some((value) => value === null || !Number.isFinite(value))) {
    return false;
  }
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] as number) <= (values[index - 1] as number)) return false;
  }
  return true;
}

function numericMetadata(frame: FrameData, key: "time" | "step"): number | null {
  const primary = frame.header[key];
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  const scalar = frame.header.scalars?.[key];
  return typeof scalar === "number" && Number.isFinite(scalar) ? scalar : null;
}

function metadataUnit(frame: FrameData, key: "time" | "step"): string | null {
  const value = frame.header.scalar_units?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function seriesSnapshot(
  title: string,
  kind: MeasurementKind,
  unit: MeasurementSuccess["unit"],
  axis: MeasurementSeriesAxis,
  xValues: readonly number[],
  values: readonly (number | null)[],
  loadedCount: number,
  complete: boolean,
): MeasurementSeries {
  return Object.freeze({
    title,
    kind,
    unit,
    axis: Object.freeze({ ...axis }),
    xValues: Object.isFrozen(xValues) ? xValues : Object.freeze([...xValues]),
    values: Object.freeze([...values]),
    loadedCount,
    complete,
  });
}

function measurementKind(count: number): MeasurementKind {
  if (count === 2) return "distance";
  if (count === 3) return "angle";
  return "dihedral";
}

function measurementUnit(kind: MeasurementKind): MeasurementSuccess["unit"] {
  return kind === "distance" ? "angstrom" : "degree";
}

function measurementTitle(
  manifest: Manifest,
  selections: readonly AtomSelection[],
  kind: MeasurementKind,
): string {
  return `${titleCase(kind)} · ${selections.map((selection) => atomLabel(manifest, selection)).join("–")}`;
}

function atomLabel(manifest: Manifest, selection: AtomSelection): string {
  const symbol = manifest.topology.symbols?.[selection.atom]
    ?? elementSymbols[manifest.topology.atomic_numbers?.[selection.atom] ?? 0]
    ?? "X";
  const image = selection.image.map((value, axis) => {
    if (value === 0) return "";
    const sign = value > 0 ? "+" : "−";
    const magnitude = Math.abs(value) === 1 ? "" : Math.abs(value);
    return `${sign}${magnitude}${"abc"[axis]}`;
  }).join("");
  const atom = `${symbol}${selection.atom + 1}`;
  return image ? `${atom} (${image})` : atom;
}

function validateRequest(
  manifest: Manifest,
  frameCount: number,
  selections: readonly AtomSelection[],
  wrap: ScenePresentation["wrap"],
): void {
  if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
    throw new RangeError("Frame count must be a non-negative integer");
  }
  if (frameCount > manifest.frame_count) {
    throw new RangeError("Frame count exceeds the trajectory manifest");
  }
  if (selections.length < 2 || selections.length > 4) {
    throw new RangeError("A measurement needs two to four selected atoms");
  }
  if (!["atom", "molecule", "none"].includes(wrap)) {
    throw new TypeError("Unknown coordinate wrapping mode");
  }
}

function frameAxis(): MeasurementSeriesAxis {
  return { kind: "frame", label: "Frame" };
}

function oneBasedFrames(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw abortReason(signal);
}

function abortReason(signal: AbortSignal, fallback?: unknown): unknown {
  if (signal.reason !== undefined) return signal.reason;
  if (isAbortError(fallback)) return fallback;
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function csvNumber(value: number | null | undefined, precision: number): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(Number(value.toPrecision(precision)))
    : "";
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function withUnit(label: string, unit: string | undefined): string {
  return unit ? `${label} [${unit}]` : label;
}

function displayUnit(unit: MeasurementSuccess["unit"]): string {
  return unit === "angstrom" ? "Å" : "°";
}

function titleCase(value: string): string {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

interface SeriesPoint {
  index: number;
  x: number;
  y: number;
}

function finiteSeriesPoints(series: MeasurementSeries): SeriesPoint[] {
  const count = Math.min(series.xValues.length, series.values.length);
  const result: SeriesPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const x = series.xValues[index];
    const y = series.values[index];
    if (Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
      result.push({ index, x, y });
    }
  }
  return result;
}

function svgPath(
  series: MeasurementSeries,
  xMap: (value: number) => number,
  yMap: (value: number) => number,
): string {
  const count = Math.min(series.xValues.length, series.values.length);
  const commands: string[] = [];
  let open = false;
  let previousValue: number | null = null;
  for (let index = 0; index < count; index += 1) {
    const x = series.xValues[index];
    const y = series.values[index];
    if (!Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
      open = false;
      previousValue = null;
      continue;
    }
    if (
      series.unit === "degree"
      && previousValue !== null
      && Math.abs(y - previousValue) > 180
    ) {
      open = false;
    }
    commands.push(`${open ? "L" : "M"}${plotNumber(xMap(x))} ${plotNumber(yMap(y))}`);
    open = true;
    previousValue = y;
  }
  return commands.join("");
}

function isolatedSvgMarkers(
  series: MeasurementSeries,
  xMap: (value: number) => number,
  yMap: (value: number) => number,
): string {
  const count = Math.min(series.xValues.length, series.values.length);
  const valid = (index: number) => {
    if (index < 0 || index >= count) return false;
    return Number.isFinite(series.xValues[index])
      && typeof series.values[index] === "number"
      && Number.isFinite(series.values[index]);
  };
  const markers: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (
      !valid(index)
      || connectedMeasurementSamples(series, index - 1, index)
      || connectedMeasurementSamples(series, index, index + 1)
    ) {
      continue;
    }
    markers.push(
      `<circle cx="${plotNumber(xMap(series.xValues[index]))}" cy="${plotNumber(yMap(series.values[index]!))}" r="3" fill="#137f78"/>`,
    );
  }
  return markers.join("");
}

function connectedMeasurementSamples(
  series: MeasurementSeries,
  left: number,
  right: number,
): boolean {
  if (left < 0 || right >= Math.min(series.xValues.length, series.values.length)) return false;
  const leftValue = series.values[left];
  const rightValue = series.values[right];
  if (
    !Number.isFinite(series.xValues[left])
    || !Number.isFinite(series.xValues[right])
    || typeof leftValue !== "number"
    || typeof rightValue !== "number"
    || !Number.isFinite(leftValue)
    || !Number.isFinite(rightValue)
  ) {
    return false;
  }
  return series.unit !== "degree" || Math.abs(rightValue - leftValue) <= 180;
}

function expandedDomain(values: readonly number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  if (minimum === maximum) {
    const padding = Math.max(Math.abs(minimum) * 0.05, 0.5);
    minimum -= padding;
    maximum += padding;
  } else {
    const padding = (maximum - minimum) * 0.04;
    minimum -= padding;
    maximum += padding;
  }
  return [minimum, maximum];
}

function ticks(minimum: number, maximum: number, count: number): number[] {
  return Array.from(
    { length: count },
    (_, index) => minimum + (maximum - minimum) * index / Math.max(count - 1, 1),
  );
}

function tickNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 10_000 || absolute < 0.001)) {
    return value.toExponential(2);
  }
  return new Intl.NumberFormat("en", { maximumFractionDigits: 4 }).format(value);
}

function plotNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function positiveDimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`SVG ${label} must be a positive integer`);
  }
  return value;
}

const elementSymbols = [
  "X", "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
  "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca",
];
