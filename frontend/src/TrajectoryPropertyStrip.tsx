import { useId, useMemo, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { DisplaySeries } from "./types";
import "./TrajectoryPropertyStrip.css";

const TRACE_WIDTH = 1000;
const TRACE_HEIGHT = 64;
const TRACE_PADDING_Y = 8;

export interface TrajectoryPropertyStripProps {
  series: DisplaySeries[];
  frameIndex: number;
  frameCount: number;
  onFrame: (index: number) => void;
}

export interface TrajectoryTraceGeometry {
  path: string;
  min: number | null;
  max: number | null;
}

interface TraceRun {
  start: number;
  end: number;
}

export function TrajectoryPropertyStrip({
  series,
  frameIndex,
  frameCount,
  onFrame,
}: TrajectoryPropertyStripProps) {
  const controlId = useId();
  const descriptionId = `${controlId}-description`;
  const [selectedName, setSelectedName] = useState(() => chooseTrajectorySeries(series, frameIndex)?.name ?? "");
  const selected = useMemo(
    () => series.find((entry) => entry.name === selectedName) ?? chooseTrajectorySeries(series, frameIndex),
    [selectedName, series],
  );
  const currentFrame = clampFrameIndex(frameIndex, frameCount);
  const geometry = useMemo(
    () => selected ? trajectoryTraceGeometry(selected.values, frameCount) : { path: "", min: null, max: null },
    [frameCount, selected],
  );

  if (!selected) {
    return (
      <section className="trajectory-property-strip is-empty" aria-label="Trajectory property">
        <span className="trajectory-property-strip__empty">No trajectory properties</span>
        <output className="trajectory-property-strip__frame">
          {frameCount > 0 ? `${currentFrame + 1} / ${frameCount}` : "—"}
        </output>
      </section>
    );
  }

  const currentValue = numericValue(selected.values[currentFrame]);
  const formattedValue = formatTrajectoryValue(currentValue);
  const unit = selected.unit?.trim();
  const displayedValue = unit ? `${formattedValue} ${unit}` : formattedValue;
  const playheadX = framePosition(currentFrame, frameCount, TRACE_WIDTH);
  const spokenValue = currentValue === null ? "not available" : displayedValue;

  function seekFromPointer(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    onFrame(frameIndexAtPosition(event.clientX, bounds.left, bounds.width, frameCount));
  }

  function handlePointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    seekFromPointer(event);
  }

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    event.preventDefault();
    seekFromPointer(event);
  }

  function handlePointerUp(event: PointerEvent<SVGSVGElement>) {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const page = Math.max(1, Math.round(Math.max(frameCount - 1, 1) / 10));
    let nextFrame: number | null = null;

    if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextFrame = currentFrame - 1;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") nextFrame = currentFrame + 1;
    if (event.key === "PageDown") nextFrame = currentFrame - page;
    if (event.key === "PageUp") nextFrame = currentFrame + page;
    if (event.key === "Home") nextFrame = 0;
    if (event.key === "End") nextFrame = frameCount - 1;
    if (nextFrame === null || frameCount <= 0) return;

    event.preventDefault();
    event.stopPropagation();
    onFrame(clampFrameIndex(nextFrame, frameCount));
  }

  return (
    <section className="trajectory-property-strip" aria-label="Trajectory property">
      <div className="trajectory-property-strip__metric">
        {series.length > 1 ? <label htmlFor={controlId}>
          <span className="trajectory-property-strip__visually-hidden">Displayed property</span>
          <select
            id={controlId}
            value={selected.name}
            onChange={(event) => setSelectedName(event.target.value)}
            title="Displayed trajectory property"
          >
            {series.map((entry, index) => (
              <option key={`${entry.name}-${index}`} value={entry.name}>{entry.label}</option>
            ))}
          </select>
        </label> : <span className="trajectory-property-strip__label">{selected.label}</span>}
        <output
          className="trajectory-property-strip__value"
          aria-label={`${selected.label} at frame ${currentFrame + 1}: ${spokenValue}`}
        >
          <strong>{formattedValue}</strong>
          {unit && <span>{unit}</span>}
        </output>
      </div>

      <div className="trajectory-property-strip__plot">
        <svg
          viewBox={`0 0 ${TRACE_WIDTH} ${TRACE_HEIGHT}`}
          preserveAspectRatio="none"
          role="slider"
          tabIndex={frameCount > 1 ? 0 : -1}
          aria-label={`${selected.label} trajectory frame`}
          aria-describedby={descriptionId}
          aria-orientation="horizontal"
          aria-valuemin={1}
          aria-valuemax={Math.max(frameCount, 1)}
          aria-valuenow={frameCount > 0 ? currentFrame + 1 : 1}
          aria-valuetext={`Frame ${currentFrame + 1} of ${frameCount}; ${selected.label}: ${spokenValue}`}
          aria-disabled={frameCount <= 1}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
        >
          <title>{selected.label} across {frameCount} frames</title>
          <desc id={descriptionId}>Click or drag to seek. Use arrow, page, home, and end keys for precise navigation.</desc>
          <g aria-hidden="true">
            <rect className="trajectory-property-strip__hit-area" width={TRACE_WIDTH} height={TRACE_HEIGHT} />
            <line className="trajectory-property-strip__grid" x1="0" x2={TRACE_WIDTH} y1="20" y2="20" />
            <line className="trajectory-property-strip__grid" x1="0" x2={TRACE_WIDTH} y1="44" y2="44" />
            {geometry.path
              ? <path className="trajectory-property-strip__trace" d={geometry.path} />
              : <line className="trajectory-property-strip__missing" x1="0" x2={TRACE_WIDTH} y1={TRACE_HEIGHT / 2} y2={TRACE_HEIGHT / 2} />}
            <line className="trajectory-property-strip__playhead" x1={playheadX} x2={playheadX} y1="2" y2={TRACE_HEIGHT - 2} />
          </g>
        </svg>
      </div>

      <output className="trajectory-property-strip__frame" aria-label={`Frame ${currentFrame + 1} of ${frameCount}`}>
        {String(currentFrame + 1).padStart(String(Math.max(frameCount, 1)).length, "0")} / {frameCount}
      </output>
    </section>
  );
}

export function chooseTrajectorySeries(series: DisplaySeries[], frameIndex = 0): DisplaySeries | null {
  if (series.length === 0) return null;

  const populated = series
    .map((entry, index) => ({ entry, index, count: populatedValueCount(entry.values) }))
    .filter(({ count }) => count > 0);
  if (populated.length === 0) return series[0];

  return populated
    .map(({ entry, index, count }) => {
      const currentPenalty = numericValue(entry.values[frameIndex]) === null ? 100 : 0;
      const coverage = count / Math.max(entry.values.length, 1);
      return { entry, index, score: trajectoryMetricRank(entry) * 10000 + currentPenalty - coverage };
    })
    .sort((left, right) => left.score - right.score || left.index - right.index)[0].entry;
}

export function trajectoryTraceGeometry(
  values: Array<number | null>,
  frameCount: number,
  width = TRACE_WIDTH,
  height = TRACE_HEIGHT,
): TrajectoryTraceGeometry {
  if (frameCount <= 0 || width <= 0 || height <= 0) return { path: "", min: null, max: null };

  const sampleCount = Math.min(values.length, frameCount);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let populated = 0;
  const runs: TraceRun[] = [];
  let runStart = -1;
  for (let index = 0; index < sampleCount; index += 1) {
    const value = numericValue(values[index]);
    if (value === null) {
      if (runStart >= 0) runs.push({ start: runStart, end: index - 1 });
      runStart = -1;
      continue;
    }
    if (runStart < 0) runStart = index;
    min = Math.min(min, value);
    max = Math.max(max, value);
    populated += 1;
  }
  if (runStart >= 0) runs.push({ start: runStart, end: sampleCount - 1 });
  if (populated === 0) return { path: "", min: null, max: null };

  const range = max - min;
  const drawableHeight = Math.max(0, height - TRACE_PADDING_Y * 2);
  const pointBudget = Math.max(256, Math.ceil(width * 2));
  const sampledRuns = sampleTraceRuns(values, runs, populated, pointBudget);
  const path = sampledRuns.map((samples) => {
    const points = samples.map(([index, value]) => {
      const x = framePosition(index, frameCount, width);
      const y = range === 0
        ? height / 2
        : TRACE_PADDING_Y + (1 - (value - min) / range) * drawableHeight;
      return [x, y] as [number, number];
    });
    const [first, ...rest] = points;
    const start = `M${plotNumber(first[0])} ${plotNumber(first[1])}`;
    if (rest.length === 0) return `${start}L${plotNumber(first[0])} ${plotNumber(first[1])}`;
    return `${start}${rest.map(([x, y]) => `L${plotNumber(x)} ${plotNumber(y)}`).join("")}`;
  }).join(" ");

  return { path, min, max };
}

function sampleTraceRuns(
  values: Array<number | null>,
  runs: TraceRun[],
  populated: number,
  pointBudget: number,
): Array<Array<[number, number]>> {
  if (populated <= pointBudget) {
    return runs.map(({ start, end }) => traceRunValues(values, start, end));
  }

  const visibleRuns = runs.length <= pointBudget
    ? runs
    : Array.from({ length: pointBudget }, (_, index) => (
      runs[Math.floor(index * (runs.length - 1) / Math.max(pointBudget - 1, 1))]
    ));
  const allocations = visibleRuns.map(() => 1);
  let remaining = pointBudget - visibleRuns.length;
  const capacities = visibleRuns.map((run) => run.end - run.start);
  const totalCapacity = capacities.reduce((sum, capacity) => sum + capacity, 0);

  if (remaining > 0 && totalCapacity > 0) {
    capacities.forEach((capacity, index) => {
      const extra = Math.min(capacity, Math.floor(remaining * capacity / totalCapacity));
      allocations[index] += extra;
    });
    remaining = pointBudget - allocations.reduce((sum, count) => sum + count, 0);
    for (let index = 0; remaining > 0 && index < visibleRuns.length; index = (index + 1) % visibleRuns.length) {
      if (allocations[index] >= capacities[index] + 1) continue;
      allocations[index] += 1;
      remaining -= 1;
    }
  }

  return visibleRuns.map((run, index) => decimateTraceRun(values, run, allocations[index]));
}

function traceRunValues(values: Array<number | null>, start: number, end: number): Array<[number, number]> {
  const samples: Array<[number, number]> = [];
  for (let index = start; index <= end; index += 1) {
    const value = numericValue(values[index]);
    if (value !== null) samples.push([index, value]);
  }
  return samples;
}

function decimateTraceRun(values: Array<number | null>, run: TraceRun, target: number): Array<[number, number]> {
  const length = run.end - run.start + 1;
  if (length <= target) return traceRunValues(values, run.start, run.end);
  if (target <= 1) {
    const value = numericValue(values[run.start]);
    return value === null ? [] : [[run.start, value]];
  }

  const firstValue = numericValue(values[run.start]);
  const lastValue = numericValue(values[run.end]);
  if (firstValue === null || lastValue === null) return traceRunValues(values, run.start, run.end);
  if (target === 2) return [[run.start, firstValue], [run.end, lastValue]];

  const samples: Array<[number, number]> = [[run.start, firstValue]];
  const interiorSlots = target - 2;
  const bucketCount = Math.ceil(interiorSlots / 2);
  const interiorLength = Math.max(0, length - 2);
  for (let bucket = 0; bucket < bucketCount && samples.length < target - 1; bucket += 1) {
    const start = run.start + 1 + Math.floor(bucket * interiorLength / bucketCount);
    const end = run.start + 1 + Math.floor((bucket + 1) * interiorLength / bucketCount);
    let minIndex = start;
    let maxIndex = start;
    let minValue = numericValue(values[start]) ?? firstValue;
    let maxValue = minValue;
    for (let index = start + 1; index < end; index += 1) {
      const value = numericValue(values[index]);
      if (value === null) continue;
      if (value < minValue) { minValue = value; minIndex = index; }
      if (value > maxValue) { maxValue = value; maxIndex = index; }
    }
    const candidates: Array<[number, number]> = minIndex === maxIndex
      ? [[minIndex, minValue]]
      : minIndex < maxIndex
        ? [[minIndex, minValue], [maxIndex, maxValue]]
        : [[maxIndex, maxValue], [minIndex, minValue]];
    const slots = target - 1 - samples.length;
    if (slots === 1 && candidates.length === 2) {
      const expected = (index: number) => firstValue
        + (lastValue - firstValue) * (index - run.start) / Math.max(run.end - run.start, 1);
      const selected = candidates.reduce((best, candidate) => (
        Math.abs(candidate[1] - expected(candidate[0])) > Math.abs(best[1] - expected(best[0])) ? candidate : best
      ));
      samples.push(selected);
    } else {
      samples.push(...candidates.slice(0, slots));
    }
  }
  samples.push([run.end, lastValue]);
  return samples;
}

export function frameIndexAtPosition(clientX: number, left: number, width: number, frameCount: number): number {
  if (frameCount <= 1 || width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (clientX - left) / width));
  return Math.round(ratio * (frameCount - 1));
}

export function formatTrajectoryValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 10000 || absolute < 0.001)) return value.toExponential(3);
  return new Intl.NumberFormat("en", { maximumFractionDigits: 4 }).format(value);
}

function trajectoryMetricRank(series: DisplaySeries): number {
  const text = `${series.name} ${series.label}`.toLowerCase();
  if (/\b(total|conserved)\s+energy\b|\benergy\s+(total|conserved)\b|\be[\s_-]?tot\b|\betot\b/.test(text)) return 0;
  if (/\bpotential\s+energy\b|\benergy\s+potential\b|\be[\s_-]?pot\b|\bepot\b/.test(text)) return 1;
  if (/\benergy\b|\bkinetic\b|\be[\s_-]?kin\b|\bekin\b/.test(text)) return 2;
  if (/\btemperature\b|\btemp\b/.test(text)) return 3;
  if (/\bpressure\b|\bpress\b/.test(text)) return 4;
  if (/\bdensity\b|\brho\b/.test(text)) return 5;
  if (/\bvolume\b|\bvol\b/.test(text)) return 6;
  if (/\btime\b|\bstep\b|\bframe\b|\bindex\b/.test(text)) return 100;
  return 10;
}

function framePosition(index: number, frameCount: number, width: number): number {
  if (frameCount <= 1) return width / 2;
  return clampFrameIndex(index, frameCount) / (frameCount - 1) * width;
}

function clampFrameIndex(index: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  return Math.max(0, Math.min(frameCount - 1, Math.round(index)));
}

function numericValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function populatedValueCount(values: Array<number | null>): number {
  let count = 0;
  for (const value of values) {
    if (numericValue(value) !== null) count += 1;
  }
  return count;
}

function plotNumber(value: number): string {
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}
