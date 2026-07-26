import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import type { PlotLine, PlotShelfData } from "./trajectoryStudy";

const DEFAULT_PLOT_WIDTH = 720;
const DEFAULT_PLOT_HEIGHT = 130;

export interface MeasurementPlotProps {
  title: string;
  unit: string;
  axisLabel: string;
  axisUnit?: string;
  xValues: readonly number[];
  values: readonly (number | null)[];
  loadedCount: number;
  complete: boolean;
  currentFrame: number;
  onFrame: (frame: number) => void;
  onExportCsv: () => void;
  onExportSvg: () => void;
  onExportPdf: () => void;
}

export interface PlotShelfProps {
  plot: PlotShelfData;
  currentFrame?: number;
  onFrame?: (frame: number) => void;
  onRestoreLine?: (line: PlotLine) => void;
  onClose?: () => void;
  headerActions?: ReactNode;
  onExportCsv: () => void;
  onExportSvg: () => void;
  onExportPdf: () => void;
}

export interface MeasurementSample {
  frame: number;
  xValue: number;
  value: number;
}

export interface MeasurementPlotPoint extends MeasurementSample {
  x: number;
  y: number;
}

export interface MeasurementPlotSegment {
  points: MeasurementPlotPoint[];
  path: string;
}

export interface MeasurementPlotGeometry {
  xDomain: [number, number];
  yDomain: [number, number];
  segments: MeasurementPlotSegment[];
}

export interface MeasurementPlotGeometryOptions {
  width?: number;
  height?: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  discontinuityThreshold?: number;
  maxPoints?: number;
  yDomain?: [number, number];
}

export interface MeasurementPlotLayout {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PlotShelfLineGeometry {
  id: string;
  color: string;
  segments: MeasurementPlotSegment[];
}

export interface PlotShelfGeometry {
  xDomain: [number, number];
  yDomain: [number, number];
  lines: PlotShelfLineGeometry[];
}

export function measurementPlotLayout(width: number, height: number): MeasurementPlotLayout {
  const resolvedWidth = Math.max(160, finiteNumber(width, DEFAULT_PLOT_WIDTH));
  const resolvedHeight = Math.max(72, finiteNumber(height, DEFAULT_PLOT_HEIGHT));
  const left = resolvedWidth <= 520 ? 58 : 64;
  const compactHeight = resolvedHeight <= 96;
  return {
    width: resolvedWidth,
    height: resolvedHeight,
    left,
    right: Math.max(left + 1, resolvedWidth - 16),
    top: compactHeight ? 8 : 12,
    bottom: Math.max(24, resolvedHeight - (compactHeight ? 24 : 38)),
  };
}

const DEFAULT_PLOT_LAYOUT = measurementPlotLayout(DEFAULT_PLOT_WIDTH, DEFAULT_PLOT_HEIGHT);
const MAX_PLOT_POINTS = 1_600;
const DEFAULT_LINE_COLORS = Object.freeze([
  "#137f78",
  "#b35c2e",
  "#5468a8",
  "#8b5a91",
  "#4f7b45",
  "#b08524",
  "#366e83",
  "#9a4d62",
]);

export function MeasurementPlot({
  title,
  unit,
  axisLabel,
  axisUnit,
  xValues,
  values,
  loadedCount,
  complete,
  currentFrame,
  onFrame,
  onExportCsv,
  onExportSvg,
  onExportPdf,
}: MeasurementPlotProps) {
  const plot = useMemo<PlotShelfData>(() => ({
    requestId: 0,
    kind: "measurement",
    title,
    xLabel: axisLabel,
    xUnit: axisUnit,
    yLabel: measurementLabel(title),
    yUnit: unit,
    xValues,
    frameIndices: xValues.map((_, index) => index),
    lines: [{
      id: "measurement",
      label: title,
      values,
      discontinuity: measurementDiscontinuityThreshold(unit),
    }],
    loadedCount,
    totalCount: xValues.length,
    complete,
  }), [
    axisLabel,
    axisUnit,
    complete,
    loadedCount,
    title,
    unit,
    values,
    xValues,
  ]);
  return (
    <PlotShelf
      plot={plot}
      currentFrame={currentFrame}
      onFrame={onFrame}
      onExportCsv={onExportCsv}
      onExportSvg={onExportSvg}
      onExportPdf={onExportPdf}
    />
  );
}

export function PlotShelf({
  plot,
  currentFrame,
  onFrame,
  onRestoreLine,
  onClose,
  headerActions,
  onExportCsv,
  onExportSvg,
  onExportPdf,
}: PlotShelfProps) {
  const {
    title,
    xLabel: axisLabel,
    xUnit: axisUnit,
    yLabel,
    yUnit,
    xValues,
    lines,
    loadedCount,
    totalCount,
    complete,
  } = plot;
  const [chartRef, chartSize] = useMeasuredPlotSize();
  const layout = useMemo(
    () => measurementPlotLayout(
      chartSize?.width ?? DEFAULT_PLOT_WIDTH,
      chartSize?.height ?? DEFAULT_PLOT_HEIGHT,
    ),
    [chartSize?.height, chartSize?.width],
  );
  const pointCount = xValues.length;
  const frameIndices = plot.frameIndices;
  const activeDataIndex = currentFrame === undefined
    ? -1
    : plotDataIndexForFrame(currentFrame, frameIndices, pointCount);
  const seekableIndices = useMemo(
    () => seekablePlotIndices(frameIndices, pointCount),
    [frameIndices, pointCount],
  );
  const seekableBounds = useMemo(
    () => seekableFrameBounds(frameIndices, seekableIndices),
    [frameIndices, seekableIndices],
  );
  const seekable = Boolean(onFrame && seekableIndices.length > 0);
  const geometry = useMemo(
    () => chartSize === null
      ? {
          xDomain: [0, Math.max(1, pointCount - 1)] as [number, number],
          yDomain: [0, 1] as [number, number],
          lines: [],
        }
      : buildPlotShelfGeometry(xValues, lines, {
          width: layout.width,
          height: layout.height,
          left: layout.left,
          right: layout.right,
          top: layout.top,
          bottom: layout.bottom,
          yDomain: plot.yFloor === undefined
            ? undefined
            : plotShelfYDomain(lines, plot.yFloor),
          maxPoints: Math.min(
            MAX_PLOT_POINTS,
            Math.ceil((layout.right - layout.left) * 2),
          ),
        }),
    [chartSize, layout, lines, plot.yFloor, pointCount, xValues],
  );
  const currentX = activeDataIndex >= 0
    ? plotXForFrame(activeDataIndex, xValues, geometry.xDomain, layout.left, layout.right)
    : null;
  const currentValues = lines.map((line) => finiteMeasurementValue(line.values[activeDataIndex]));
  const boundedLoadedCount = Math.max(
    0,
    Math.min(totalCount, Number.isFinite(loadedCount) ? Math.floor(loadedCount) : 0),
  );
  const axisTitle = axisUnit ? `${axisLabel} (${axisUnit})` : axisLabel;
  const yAxisTitle = yUnit ? `${yLabel} (${yUnit})` : yLabel;
  const countNoun = plot.kind === "rdf" ? "bins" : "frames";
  const countStatus = complete
    ? `${totalCount.toLocaleString()} ${countNoun}`
    : `${boundedLoadedCount.toLocaleString()} / ${totalCount.toLocaleString()} ${countNoun}`;
  const status = plot.context ? `${countStatus} · ${plot.context}` : countStatus;
  const valueText = activeDataIndex >= 0
    ? currentPlotValueText(
        activeDataIndex,
        currentFrame!,
        xValues,
        lines,
        axisLabel,
        axisUnit,
        yUnit,
      )
    : "No linked frame";

  const seekFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (!seekable || !onFrame) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const plotX = clientXToPlotX(event.clientX, bounds, layout.width);
    if (plotX === null) return;
    const dataIndex = nearestFrameForPlotX(plotX, xValues, layout.left, layout.right);
    const target = exactFrameAt(frameIndices, dataIndex);
    if (target !== null) onFrame(target);
  };

  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !seekable) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  };

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    seekFromPointer(event);
  };

  const releasePointer = (event: PointerEvent<SVGSVGElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!seekable || !onFrame) return;
    let nextDataIndex: number | null = null;
    const activePosition = Math.max(0, seekableIndices.indexOf(activeDataIndex));
    if (event.key === "ArrowLeft") {
      nextDataIndex = seekableIndices[Math.max(0, activePosition - 1)];
    }
    if (event.key === "ArrowRight") {
      nextDataIndex = seekableIndices[Math.min(seekableIndices.length - 1, activePosition + 1)];
    }
    if (event.key === "Home") nextDataIndex = seekableIndices[0];
    if (event.key === "End") nextDataIndex = seekableIndices.at(-1) ?? null;
    if (nextDataIndex === null) return;
    const nextFrame = exactFrameAt(frameIndices, nextDataIndex);
    if (nextFrame === null) return;
    event.preventDefault();
    onFrame(nextFrame);
  };

  return (
    <section
      className={complete ? "measurement-plot is-complete" : "measurement-plot"}
      aria-label={`${title} trajectory plot`}
    >
      <header className="measurement-plot__header">
        <div className="measurement-plot__meta">
          <strong title={title}>{title}</strong>
          <span title={complete ? status : undefined}>{complete ? status : "Loading data"}</span>
        </div>
        <div className="measurement-plot__legend" role="group" aria-label="Current values">
          {lines.map((line, index) => {
            const color = plotLineColor(line.color, index);
            const value = currentValues[index];
            const text = activeDataIndex < 0
              ? null
              : value === null
                ? "unavailable"
                : `${formatTick(value)}${yUnit ? ` ${yUnit}` : ""}`;
            const contents = (
              <>
                <span
                  className="measurement-plot__legend-swatch"
                  aria-hidden="true"
                  style={{ backgroundColor: color }}
                />
                <span>{line.label}</span>
                {text !== null && (
                  <output aria-label={`${line.label} current value`}>{text}</output>
                )}
              </>
            );
            return onRestoreLine && line.selection ? (
              <button
                className="measurement-plot__legend-item"
                key={line.id}
                type="button"
                onClick={() => onRestoreLine(line)}
                aria-label={text === null
                  ? `Restore ${line.label}`
                  : `Restore ${line.label}; current value ${text}`}
              >
                {contents}
              </button>
            ) : (
              <span
              className="measurement-plot__legend-item"
              key={line.id}
            >
                {contents}
              </span>
            );
          })}
        </div>
        <div
          className="measurement-plot__header-actions"
          role="group"
          aria-label="Plot controls"
        >
          {headerActions && (
            <div className="measurement-plot__context-actions">
              {headerActions}
            </div>
          )}
          <div className="measurement-plot__actions">
            <details className="measurement-plot__export-menu">
              <summary>Export</summary>
              <div>
                <button type="button" onClick={onExportCsv} disabled={!complete}>CSV</button>
                <button type="button" onClick={onExportSvg} disabled={!complete}>SVG</button>
                <button type="button" onClick={onExportPdf} disabled={!complete}>PDF</button>
              </div>
            </details>
            <button type="button" onClick={onExportCsv} disabled={!complete}>CSV</button>
            <button type="button" onClick={onExportSvg} disabled={!complete}>SVG</button>
            <button type="button" onClick={onExportPdf} disabled={!complete}>PDF</button>
            {onClose && (
              <button
                className="measurement-plot__close"
                type="button"
                onClick={onClose}
                aria-label="Close plot"
                title="Close"
              >
                ×
              </button>
            )}
          </div>
        </div>
      </header>

      <svg
        ref={chartRef}
        className={seekable
          ? "measurement-plot__chart is-seekable"
          : "measurement-plot__chart"}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role={seekable ? "slider" : "img"}
        tabIndex={seekable ? 0 : undefined}
        aria-label={seekable ? `${title} frame` : title}
        aria-orientation={seekable ? "horizontal" : undefined}
        aria-valuemin={seekable ? seekableBounds?.[0] : undefined}
        aria-valuemax={seekable ? seekableBounds?.[1] : undefined}
        aria-valuenow={seekable && currentFrame !== undefined ? currentFrame : undefined}
        aria-valuetext={seekable ? valueText : undefined}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={releasePointer}
        onPointerCancel={releasePointer}
        style={{
          touchAction: seekable ? "none" : "auto",
          cursor: seekable ? "crosshair" : "default",
        }}
      >
        <title>{title}</title>
        <desc>
          {seekable
            ? "Tap or drag to seek. Use arrow keys, Home, or End to move between frames."
            : `${lines.length} plotted series.`}
        </desc>
        <line
          className="measurement-plot__grid"
          x1={layout.left}
          x2={layout.right}
          y1={layout.top}
          y2={layout.top}
        />
        <line
          className="measurement-plot__grid"
          x1={layout.left}
          x2={layout.right}
          y1={(layout.top + layout.bottom) / 2}
          y2={(layout.top + layout.bottom) / 2}
        />
        <line
          className="measurement-plot__axis"
          x1={layout.left}
          x2={layout.right}
          y1={layout.bottom}
          y2={layout.bottom}
        />

        {geometry.lines.flatMap((line) => line.segments.map((segment, index) => (
          segment.points.length === 1 ? (
            <circle
              className="measurement-plot__trace-point"
              key={`${line.id}-point-${segment.points[0].frame}-${index}`}
              cx={segment.points[0].x}
              cy={segment.points[0].y}
              r={2}
              style={{ fill: line.color }}
            />
          ) : (
            <path
              className="measurement-plot__trace"
              key={`${line.id}-trace-${segment.points[0].frame}-${index}`}
              d={segment.path}
              fill="none"
              vectorEffect="non-scaling-stroke"
              style={{ stroke: line.color }}
            />
          )
        )))}
        {geometry.lines.every(({ segments }) => segments.length === 0) && (
          <text
            className="measurement-plot__empty"
            x={(layout.left + layout.right) / 2}
            y={(layout.top + layout.bottom) / 2}
            textAnchor="middle"
          >
            {complete ? "No valid data" : "Loading data…"}
          </text>
        )}

        {currentX !== null && (
          <line
            className="measurement-plot__cursor"
            x1={currentX}
            x2={currentX}
            y1={layout.top}
            y2={layout.bottom}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {currentX !== null && currentValues.map((value, index) => value === null ? null : (
          <circle
            className="measurement-plot__cursor-point"
            key={`cursor-${lines[index].id}`}
            cx={currentX}
            cy={scaleLinear(value, geometry.yDomain, layout.bottom, layout.top)}
            r={4}
            style={{ fill: plotLineColor(lines[index].color, index) }}
          />
        ))}

        <text className="measurement-plot__tick" x={layout.left} y={layout.bottom + 17}>
          {formatTick(geometry.xDomain[0])}
        </text>
        <text
          className="measurement-plot__tick"
          x={layout.right}
          y={layout.bottom + 17}
          textAnchor="end"
        >
          {formatTick(geometry.xDomain[1])}
        </text>
        <text
          className="measurement-plot__tick"
          x={layout.left - 8}
          y={layout.top + 4}
          textAnchor="end"
        >
          {formatTick(geometry.yDomain[1])}
        </text>
        <text
          className="measurement-plot__tick"
          x={layout.left - 8}
          y={layout.bottom}
          textAnchor="end"
        >
          {formatTick(geometry.yDomain[0])}
        </text>
        <text
          className="measurement-plot__axis-label"
          x={(layout.left + layout.right) / 2}
          y={layout.height - 4}
          textAnchor="middle"
        >
          {axisTitle}
        </text>
        <text
          className="measurement-plot__unit"
          x={12}
          y={(layout.top + layout.bottom) / 2}
          textAnchor="middle"
          transform={`rotate(-90 12 ${(layout.top + layout.bottom) / 2})`}
        >
          {yAxisTitle}
        </text>
      </svg>

      {!complete && (
        <div className="measurement-plot__progress" role="status" aria-live="polite">
          <progress
            aria-label={plot.kind === "rdf" ? "Bins loaded" : "Frames loaded"}
            max={Math.max(1, totalCount)}
            value={boundedLoadedCount}
          />
          <span>{status}</span>
        </div>
      )}
    </section>
  );
}

function useMeasuredPlotSize() {
  const chartRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let resizeTimer: number | null = null;
    let pendingSize: { width: number; height: number } | null = null;

    const update = (width: number, height: number) => {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      const next = {
        width: Math.round(width),
        height: Math.round(height),
      };
      setSize((current) => (
        current
        && current.width === next.width
        && current.height === next.height
          ? current
          : next
      ));
    };

    let initialFrame: number | null = window.requestAnimationFrame(() => {
      initialFrame = window.requestAnimationFrame(() => {
        const bounds = chart.getBoundingClientRect();
        update(bounds.width, bounds.height);
        initialFrame = null;
      });
    });
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      pendingSize = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (pendingSize) update(pendingSize.width, pendingSize.height);
        resizeTimer = null;
      }, 80);
    });
    observer.observe(chart);
    return () => {
      observer.disconnect();
      if (initialFrame !== null) window.cancelAnimationFrame(initialFrame);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    };
  }, []);

  return [chartRef, size] as const;
}

export function buildMeasurementPlotGeometry(
  xValues: readonly number[],
  values: readonly (number | null)[],
  options: MeasurementPlotGeometryOptions = {},
): MeasurementPlotGeometry {
  const width = positiveNumber(options.width, DEFAULT_PLOT_LAYOUT.width);
  const height = positiveNumber(options.height, DEFAULT_PLOT_LAYOUT.height);
  const left = finiteNumber(options.left, DEFAULT_PLOT_LAYOUT.left);
  const right = finiteNumber(options.right, width - (DEFAULT_PLOT_LAYOUT.width - DEFAULT_PLOT_LAYOUT.right));
  const top = finiteNumber(options.top, DEFAULT_PLOT_LAYOUT.top);
  const bottom = finiteNumber(options.bottom, height - (DEFAULT_PLOT_LAYOUT.height - DEFAULT_PLOT_LAYOUT.bottom));
  const rawSegments = splitMeasurementSegments(
    xValues,
    values,
    options.discontinuityThreshold,
  );
  const xDomain = numericDomain(
    xValues.map((value, frame) => finiteNumber(value, frame)),
    [0, Math.max(1, xValues.length - 1)],
    false,
  );
  const yDomain = options.yDomain
    ? numericDomain(options.yDomain, [0, 1], false)
    : numericDomain(
        rawSegments.flatMap((segment) => segment.map(({ value }) => value)),
        [0, 1],
        true,
      );
  const maxPoints = Math.max(
    2,
    Math.floor(positiveNumber(options.maxPoints, Math.max(2, (right - left) * 2))),
  );
  const sampledSegments = downsampleMeasurementSegments(rawSegments, maxPoints);
  const segments = sampledSegments.map((segment) => {
    const points = segment.map((sample) => ({
      ...sample,
      x: scaleLinear(sample.xValue, xDomain, left, right),
      y: scaleLinear(sample.value, yDomain, bottom, top),
    }));
    return {
      points,
      path: points.map(
        (point, index) => `${index === 0 ? "M" : "L"}${roundCoordinate(point.x)} ${roundCoordinate(point.y)}`,
      ).join(" "),
    };
  });
  return { xDomain, yDomain, segments };
}

export function buildPlotShelfGeometry(
  xValues: readonly number[],
  lines: readonly PlotLine[],
  options: MeasurementPlotGeometryOptions = {},
): PlotShelfGeometry {
  const yDomain = options.yDomain ?? numericDomain(
    lines.flatMap(({ values }) => values.flatMap((value) => (
      typeof value === "number" && Number.isFinite(value) ? [value] : []
    ))),
    [0, 1],
    true,
  );
  const totalBudget = Math.max(
    2,
    Math.floor(positiveNumber(options.maxPoints, MAX_PLOT_POINTS)),
  );
  const lineBudget = Math.max(2, Math.floor(totalBudget / Math.max(1, lines.length)));
  const geometries = lines.map((line, index) => {
    const geometry = buildMeasurementPlotGeometry(xValues, line.values, {
      ...options,
      yDomain,
      discontinuityThreshold: line.discontinuity,
      maxPoints: lineBudget,
    });
    return {
      id: line.id,
      color: plotLineColor(line.color, index),
      segments: geometry.segments,
    };
  });
  const xDomain = geometries.length > 0
    ? buildMeasurementPlotGeometry(xValues, [], { ...options, yDomain }).xDomain
    : numericDomain(
        xValues.map((value, index) => finiteNumber(value, index)),
        [0, Math.max(1, xValues.length - 1)],
        false,
      );
  return { xDomain, yDomain, lines: geometries };
}

export function plotShelfYDomain(
  lines: readonly PlotLine[],
  floor: number,
): [number, number] {
  const domain = numericDomain(
    lines.flatMap(({ values }) => values.flatMap((value) => (
      typeof value === "number" && Number.isFinite(value) ? [value] : []
    ))),
    [floor, floor + 1],
    true,
  );
  const minimum = Number.isFinite(floor) ? floor : domain[0];
  return [minimum, domain[1] > minimum ? domain[1] : minimum + 1];
}

export function splitMeasurementSegments(
  xValues: readonly number[],
  values: readonly (number | null)[],
  discontinuityThreshold?: number,
): MeasurementSample[][] {
  const segments: MeasurementSample[][] = [];
  let segment: MeasurementSample[] = [];
  let previousValue: number | null = null;
  const threshold = Number.isFinite(discontinuityThreshold)
    ? Math.abs(discontinuityThreshold as number)
    : null;

  for (let frame = 0; frame < xValues.length; frame += 1) {
    const xValue = xValues[frame];
    const value = finiteMeasurementValue(values[frame]);
    const breaksTrace = value === null
      || !Number.isFinite(xValue)
      || (threshold !== null
        && previousValue !== null
        && Math.abs(value - previousValue) > threshold);
    if (breaksTrace) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
      previousValue = value;
      if (value === null || !Number.isFinite(xValue)) previousValue = null;
      if (value === null || !Number.isFinite(xValue)) continue;
    }
    segment.push({ frame, xValue, value });
    previousValue = value;
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

export function downsampleMeasurementSegments(
  segments: readonly (readonly MeasurementSample[])[],
  maxPoints: number,
): MeasurementSample[][] {
  const source = segments.filter((segment) => segment.length > 0);
  const totalPoints = source.reduce((sum, segment) => sum + segment.length, 0);
  const limit = Math.max(1, Math.floor(finiteNumber(maxPoints, 1)));
  if (totalPoints <= limit) return source.map((segment) => [...segment]);

  if (source.length >= limit) {
    return evenlySpacedIndices(source.length, limit).map((index) => {
      const segment = source[index];
      return [segment[Math.floor((segment.length - 1) / 2)]];
    });
  }

  const budgets = source.map((segment) => Math.min(segment.length, segment.length > 1 ? 2 : 1));
  let remaining = limit - budgets.reduce((sum, value) => sum + value, 0);
  if (remaining < 0) {
    return evenlySpacedIndices(source.length, limit).map((index) => [source[index][0]]);
  }

  while (remaining > 0) {
    const candidates = source
      .map((segment, index) => ({ index, capacity: segment.length - budgets[index] }))
      .filter(({ capacity }) => capacity > 0)
      .sort((a, b) => b.capacity - a.capacity);
    if (candidates.length === 0) break;
    for (const { index } of candidates) {
      if (remaining === 0) break;
      budgets[index] += 1;
      remaining -= 1;
    }
  }

  return source.map((segment, index) => downsampleSegment(segment, budgets[index]));
}

export function nearestFrameForPlotX(
  targetX: number,
  xValues: readonly number[],
  left = DEFAULT_PLOT_LAYOUT.left,
  right = DEFAULT_PLOT_LAYOUT.right,
): number {
  if (xValues.length === 0) return 0;
  const clampedTarget = Math.max(Math.min(left, right), Math.min(Math.max(left, right), targetX));
  const first = xValues[0];
  const last = xValues[xValues.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last) || (last as number) < (first as number)) {
    return nearestFrameLinear(clampedTarget, xValues, left, right);
  }
  if (first === last) {
    const fraction = right === left ? 0 : (clampedTarget - left) / (right - left);
    return Math.max(0, Math.min(xValues.length - 1, Math.round(fraction * (xValues.length - 1))));
  }
  const targetValue = scaleLinear(clampedTarget, [left, right], first, last);
  let low = 0;
  let high = xValues.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (xValues[middle] < targetValue) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  const previous = low - 1;
  return Math.abs(xValues[low] - targetValue) < Math.abs(xValues[previous] - targetValue)
    ? low
    : previous;
}

export function plotDataIndexForFrame(
  frame: number,
  frameIndices: readonly (number | null)[] | undefined,
  pointCount: number,
): number {
  if (!Number.isSafeInteger(frame) || frame < 0 || !frameIndices) return -1;
  if (frame < pointCount && frameIndices[frame] === frame) return frame;
  const limit = Math.min(pointCount, frameIndices.length);
  for (let index = 0; index < limit; index += 1) {
    if (frameIndices[index] === frame) return index;
  }
  return -1;
}

export function seekablePlotIndices(
  frameIndices: readonly (number | null)[] | undefined,
  pointCount: number,
): number[] {
  if (!frameIndices) return [];
  const result: number[] = [];
  const limit = Math.min(pointCount, frameIndices.length);
  for (let index = 0; index < limit; index += 1) {
    const frame = frameIndices[index];
    if (typeof frame === "number" && Number.isSafeInteger(frame) && frame >= 0) {
      result.push(index);
    }
  }
  return result;
}

export function exactFrameAt(
  frameIndices: readonly (number | null)[] | undefined,
  dataIndex: number,
): number | null {
  const frame = frameIndices?.[dataIndex];
  return typeof frame === "number" && Number.isSafeInteger(frame) && frame >= 0
    ? frame
    : null;
}

export function seekableFrameBounds(
  frameIndices: readonly (number | null)[] | undefined,
  dataIndices: readonly number[],
): [number, number] | null {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const dataIndex of dataIndices) {
    const frame = exactFrameAt(frameIndices, dataIndex);
    if (frame === null) continue;
    minimum = Math.min(minimum, frame);
    maximum = Math.max(maximum, frame);
  }
  return Number.isFinite(minimum) && Number.isFinite(maximum)
    ? [minimum, maximum]
    : null;
}

function nearestFrameLinear(
  targetX: number,
  xValues: readonly number[],
  left: number,
  right: number,
): number {
  const normalizedValues = xValues.map((value, frame) => finiteNumber(value, frame));
  const domain = numericDomain(normalizedValues, [0, Math.max(1, xValues.length - 1)], false);
  const targetValue = scaleLinear(targetX, [left, right], domain[0], domain[1]);
  let nearestFrame = 0;
  let nearestDistance = Infinity;
  normalizedValues.forEach((value, frame) => {
    const distance = Math.abs(value - targetValue);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestFrame = frame;
    }
  });
  return nearestFrame;
}

export function clientXToPlotX(
  clientX: number,
  bounds: Pick<DOMRect, "left" | "width">,
  viewBoxWidth = DEFAULT_PLOT_WIDTH,
): number | null {
  if (bounds.width <= 0 || !Number.isFinite(viewBoxWidth) || viewBoxWidth <= 0) return null;
  return (clientX - bounds.left) / bounds.width * viewBoxWidth;
}

export function measurementDiscontinuityThreshold(unit: string): number | undefined {
  const normalized = unit.trim().toLowerCase();
  return normalized === "°" || normalized === "deg" || normalized.startsWith("degree")
    ? 180
    : undefined;
}

function downsampleSegment(
  segment: readonly MeasurementSample[],
  threshold: number,
): MeasurementSample[] {
  if (threshold >= segment.length || threshold <= 0) return [...segment];
  if (threshold === 1) return [segment[0]];
  if (threshold === 2) return [segment[0], segment[segment.length - 1]];

  const sampled: MeasurementSample[] = [segment[0]];
  const bucketWidth = (segment.length - 2) / (threshold - 2);
  let selectedIndex = 0;

  for (let bucket = 0; bucket < threshold - 2; bucket += 1) {
    const nextStart = Math.min(
      segment.length,
      Math.floor((bucket + 1) * bucketWidth) + 1,
    );
    const nextEnd = Math.min(
      segment.length,
      Math.floor((bucket + 2) * bucketWidth) + 1,
    );
    let averageX = 0;
    let averageY = 0;
    const averageCount = Math.max(1, nextEnd - nextStart);
    for (let index = nextStart; index < nextEnd; index += 1) {
      averageX += segment[index].xValue;
      averageY += segment[index].value;
    }
    if (nextStart === nextEnd) {
      averageX = segment[segment.length - 1].xValue;
      averageY = segment[segment.length - 1].value;
    } else {
      averageX /= averageCount;
      averageY /= averageCount;
    }

    const rangeStart = Math.floor(bucket * bucketWidth) + 1;
    const rangeEnd = Math.min(
      segment.length - 1,
      Math.floor((bucket + 1) * bucketWidth) + 1,
    );
    const selected = segment[selectedIndex];
    let largestArea = -1;
    let nextSelectedIndex = rangeStart;
    for (let index = rangeStart; index < rangeEnd; index += 1) {
      const candidate = segment[index];
      const area = Math.abs(
        (selected.xValue - averageX) * (candidate.value - selected.value)
        - (selected.xValue - candidate.xValue) * (averageY - selected.value),
      );
      if (area > largestArea) {
        largestArea = area;
        nextSelectedIndex = index;
      }
    }
    sampled.push(segment[nextSelectedIndex]);
    selectedIndex = nextSelectedIndex;
  }
  sampled.push(segment[segment.length - 1]);
  return sampled;
}

function numericDomain(
  values: readonly number[],
  fallback: [number, number],
  pad: boolean,
): [number, number] {
  let minimum = Infinity;
  let maximum = -Infinity;
  values.forEach((value) => {
    if (!Number.isFinite(value)) return;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  });
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return fallback;
  if (minimum === maximum) {
    const margin = Math.max(Math.abs(minimum) * 0.05, 0.5);
    minimum -= margin;
    maximum += margin;
  } else if (pad) {
    const margin = (maximum - minimum) * 0.08;
    minimum -= margin;
    maximum += margin;
  }
  return [minimum, maximum];
}

function plotXForFrame(
  frame: number,
  xValues: readonly number[],
  domain: [number, number],
  left: number,
  right: number,
): number {
  return scaleLinear(finiteNumber(xValues[frame], frame), domain, left, right);
}

function scaleLinear(
  value: number,
  domain: readonly [number, number],
  rangeStart: number,
  rangeEnd: number,
): number {
  if (domain[0] === domain[1]) return (rangeStart + rangeEnd) / 2;
  return rangeStart + (value - domain[0]) / (domain[1] - domain[0]) * (rangeEnd - rangeStart);
}

function finiteMeasurementValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function evenlySpacedIndices(length: number, count: number): number[] {
  if (count <= 1) return [0];
  return Array.from(
    { length: count },
    (_, index) => Math.round(index * (length - 1) / (count - 1)),
  );
}

function roundCoordinate(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function formatTick(value: number): string {
  const magnitude = Math.abs(value);
  if ((magnitude > 0 && magnitude < 0.001) || magnitude >= 10_000) {
    return value.toExponential(2);
  }
  return Number(value.toPrecision(4)).toString();
}

function currentPlotValueText(
  dataIndex: number,
  frame: number,
  xValues: readonly number[],
  lines: readonly PlotLine[],
  axisLabel: string,
  axisUnit: string | undefined,
  yUnit: string | undefined,
): string {
  const axisValue = finiteNumber(xValues[dataIndex], dataIndex);
  const axis = `${axisLabel} ${formatTick(axisValue)}${axisUnit ? ` ${axisUnit}` : ""}`;
  const values = lines.map((line) => {
    const value = finiteMeasurementValue(line.values[dataIndex]);
    return `${line.label} ${value === null
      ? "unavailable"
      : `${formatTick(value)}${yUnit ? ` ${yUnit}` : ""}`}`;
  });
  return [`Frame ${frame + 1}`, axis, ...values].join("; ");
}

function measurementLabel(title: string): string {
  const separator = title.indexOf(" · ");
  return separator > 0 ? title.slice(0, separator) : "Measurement";
}

function plotLineColor(color: string | undefined, index: number): string {
  const value = color?.trim();
  return value && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : DEFAULT_LINE_COLORS[index % DEFAULT_LINE_COLORS.length];
}

export default MeasurementPlot;
