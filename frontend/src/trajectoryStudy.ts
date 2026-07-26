import type {
  AtomSelection,
  FrameData,
  FrameKey,
} from "./types";

export type TrackingMode = "off" | "trail" | "displacement";
export type PlotKind = "measurement" | "comparison" | "property" | "rdf";

export interface FrameMark {
  readonly index: number;
  readonly key: FrameKey;
  readonly step: number | null;
  readonly time: number | null;
  readonly timeUnit: string | null;
}

export interface PlotLine {
  readonly id: string;
  readonly label: string;
  readonly values: readonly (number | null)[];
  readonly color?: string;
  readonly selection?: readonly AtomSelection[];
  readonly minimumImage?: boolean;
  readonly discontinuity?: number;
}

export interface PlotShelfData {
  readonly requestId: number;
  readonly kind: PlotKind;
  readonly title: string;
  readonly xLabel: string;
  readonly xUnit?: string;
  readonly yLabel: string;
  readonly yUnit?: string;
  readonly yFloor?: number;
  readonly context?: string;
  readonly xValues: readonly number[];
  readonly frameIndices?: readonly (number | null)[];
  readonly frameKeys?: readonly (FrameKey | null)[];
  readonly lines: readonly PlotLine[];
  readonly loadedCount: number;
  readonly totalCount: number;
  readonly complete: boolean;
}

export interface TrajectoryStudyState {
  readonly bookmarks: readonly FrameMark[];
  readonly reference: FrameMark | null;
  readonly tracking: TrackingMode;
  readonly plot: PlotShelfData | null;
}

export type TrajectoryStudyAction =
  | { type: "reset"; preserveMarks?: boolean }
  | { type: "toggle-bookmark"; mark: FrameMark }
  | { type: "set-reference"; mark: FrameMark }
  | { type: "clear-reference" }
  | { type: "set-tracking"; mode: TrackingMode }
  | { type: "open-plot"; plot: PlotShelfData }
  | { type: "update-plot"; plot: PlotShelfData }
  | { type: "close-plot" };

export const initialTrajectoryStudyState: TrajectoryStudyState = Object.freeze({
  bookmarks: Object.freeze([]),
  reference: null,
  tracking: "off",
  plot: null,
});

const MAX_BOOKMARKS = 12;

export function trajectoryStudyReducer(
  state: TrajectoryStudyState,
  action: TrajectoryStudyAction,
): TrajectoryStudyState {
  switch (action.type) {
    case "reset":
      return action.preserveMarks
        ? {
            ...initialTrajectoryStudyState,
            bookmarks: state.bookmarks,
            reference: state.reference,
          }
        : initialTrajectoryStudyState;
    case "toggle-bookmark": {
      const existing = state.bookmarks.findIndex(({ key }) => sameFrameKey(key, action.mark.key));
      const bookmarks = existing >= 0
        ? state.bookmarks.filter((_, index) => index !== existing)
        : [...state.bookmarks, cloneFrameMark(action.mark)]
            .sort((left, right) => left.index - right.index)
            .slice(-MAX_BOOKMARKS);
      return { ...state, bookmarks: Object.freeze(bookmarks) };
    }
    case "set-reference":
      return { ...state, reference: cloneFrameMark(action.mark) };
    case "clear-reference":
      return {
        ...state,
        reference: null,
        tracking: state.tracking === "displacement" ? "off" : state.tracking,
      };
    case "set-tracking":
      return {
        ...state,
        tracking: action.mode === "displacement" && state.reference === null
          ? "off"
          : action.mode,
      };
    case "open-plot":
      return { ...state, plot: clonePlot(action.plot) };
    case "update-plot":
      return state.plot?.requestId === action.plot.requestId
        ? { ...state, plot: clonePlot(action.plot) }
        : state;
    case "close-plot":
      return { ...state, plot: null };
  }
}

export function frameMark(
  index: number,
  frame: FrameData | null,
): FrameMark | null {
  if (!Number.isSafeInteger(index) || index < 0) return null;
  const key = frame?.header.frame_key;
  if (!isFrameKey(key)) return null;
  return {
    index,
    key: cloneFrameKey(key),
    step: numericFrameValue(frame, "step"),
    time: numericFrameValue(frame, "time"),
    timeUnit: normalizedUnit(frame?.header.scalar_units?.time),
  };
}

export function sameFrameKey(
  left: FrameKey | null | undefined,
  right: FrameKey | null | undefined,
): boolean {
  return Boolean(
    left
    && right
    && left.source_id === right.source_id
    && left.source_index === right.source_index
    && left.segment_index === right.segment_index
    && nullableNumber(left.step) === nullableNumber(right.step)
    && nullableNumber(left.time) === nullableNumber(right.time)
    && (left.time_unit ?? null) === (right.time_unit ?? null),
  );
}

export function frameMarkLabel(mark: FrameMark): string {
  const details = [
    mark.step === null ? "" : `step ${formatMarkNumber(mark.step)}`,
    mark.time === null
      ? ""
      : `t ${formatMarkNumber(mark.time)}${mark.timeUnit ? ` ${mark.timeUnit}` : ""}`,
  ].filter(Boolean);
  return [`Frame ${mark.index + 1}`, ...details].join(" · ");
}

export function compatibleComparisonLines(
  lines: readonly PlotLine[],
  yUnit: string | undefined,
): boolean {
  return lines.length >= 2
    && lines.every(({ values }) => values.length === lines[0].values.length)
    && Boolean(yUnit);
}

function cloneFrameMark(mark: FrameMark): FrameMark {
  return Object.freeze({
    ...mark,
    key: Object.freeze(cloneFrameKey(mark.key)),
  });
}

function cloneFrameKey(key: FrameKey): FrameKey {
  return {
    source_id: key.source_id,
    source_index: key.source_index,
    segment_index: key.segment_index,
    step: key.step ?? null,
    time: key.time ?? null,
    time_unit: key.time_unit ?? null,
  };
}

function clonePlot(plot: PlotShelfData): PlotShelfData {
  return Object.freeze({
    ...plot,
    xValues: Object.freeze([...plot.xValues]),
    frameIndices: plot.frameIndices
      ? Object.freeze([...plot.frameIndices])
      : undefined,
    frameKeys: plot.frameKeys
      ? Object.freeze(plot.frameKeys.map((key) => key ? Object.freeze(cloneFrameKey(key)) : null))
      : undefined,
    lines: Object.freeze(plot.lines.map((line) => Object.freeze({
      ...line,
      values: Object.freeze([...line.values]),
      selection: line.selection
        ? Object.freeze(line.selection.map(({ atom, image }) => Object.freeze({
            atom,
            image: Object.freeze([...image]) as unknown as AtomSelection["image"],
          })))
        : undefined,
    }))),
  });
}

function isFrameKey(value: FrameKey | undefined): value is FrameKey {
  return Boolean(
    value
    && typeof value.source_id === "string"
    && value.source_id.length > 0
    && Number.isSafeInteger(value.source_index)
    && value.source_index >= 0
    && Number.isSafeInteger(value.segment_index)
    && value.segment_index >= 0,
  );
}

function numericFrameValue(
  frame: FrameData | null,
  key: "step" | "time",
): number | null {
  const direct = frame?.header[key];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const scalar = frame?.header.scalars?.[key];
  return typeof scalar === "number" && Number.isFinite(scalar) ? scalar : null;
}

function normalizedUnit(value: string | null | undefined): string | null {
  const unit = value?.trim();
  return unit || null;
}

function nullableNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatMarkNumber(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 5 }).format(value);
}
