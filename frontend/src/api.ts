import type {
  DisplaySeries,
  FrameData,
  FrameHeader,
  FrameKey,
  Manifest,
  SeriesSpec,
} from "./types";

const utf8 = new TextDecoder();
const DEFAULT_FRAME_CACHE_LIMIT = 96;
const DEFAULT_FRAME_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_PENDING_PREFETCH_LIMIT = 4;

export type FrameCoordinateMode = "source" | "unwrapped";

export interface SelectedPositionsRequest {
  datasetGeneration: string;
  atomIndices: readonly number[];
  frameIndices: readonly number[];
  coordinates?: FrameCoordinateMode;
}

export interface SelectedPositionFrame {
  index: number;
  key: FrameKey;
  positions: Float32Array;
  step: number | null;
  time: number | null;
  timeUnit: string | null;
}

export interface SelectedPositions {
  schemaVersion: number;
  datasetGeneration: string;
  atomIndices: readonly number[];
  unit: string;
  frames: readonly SelectedPositionFrame[];
}

export interface RdfAnalysisRequest {
  datasetGeneration: string;
  referenceIndices: readonly number[];
  targetIndices: readonly number[];
  frameStart?: number;
  frameStop?: number;
  frameStep?: number;
  bins?: number;
  rMax?: number;
}

export interface RdfFrameRange {
  start: number;
  stop: number;
  step: number;
  count: number;
  firstKey: FrameKey;
  lastKey: FrameKey;
}

export interface RdfAnalysisResult {
  schemaVersion: number;
  datasetGeneration: string;
  referenceIndices: readonly number[];
  targetIndices: readonly number[];
  frameRange: RdfFrameRange;
  radiusUnit: string;
  rdfUnit: string;
  coordinationUnit: string;
  bins: number;
  rMax: number;
  deltaR: number;
  radiusCenters: readonly number[];
  gR: readonly number[];
  coordinationRadius: readonly number[];
  coordination: readonly number[];
  pqAnalysisVersion?: string;
  elapsedSeconds?: number;
}

export async function getManifest(): Promise<Manifest> {
  const response = await fetch("/api/manifest", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(await responseMessage(response, "Could not load the trajectory"));
  const manifest = (await response.json()) as Manifest;
  validateManifest(manifest, "The trajectory manifest is incomplete");
  return manifest;
}

export async function getInitialRecipe(): Promise<unknown> {
  const response = await fetch("/api/initial-recipe", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(await responseMessage(response, "Could not load the figure recipe"));
  }
  return response.json();
}

export async function getSelectedPositions(
  request: SelectedPositionsRequest,
  signal?: AbortSignal,
): Promise<SelectedPositions> {
  const response = await fetch("/api/positions", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      dataset_generation: request.datasetGeneration,
      atom_indices: request.atomIndices,
      frame_indices: request.frameIndices,
      coordinates: request.coordinates ?? "unwrapped",
    }),
    signal,
  });
  if (response.status === 409) {
    throw new DatasetChangedError(
      await responseMessage(response, "Trajectory changed. Reloading."),
    );
  }
  if (!response.ok) {
    throw new Error(await responseMessage(response, "Could not load selected positions"));
  }
  return parseSelectedPositions(await response.json(), request);
}

export async function runRdfAnalysis(
  request: RdfAnalysisRequest,
  signal?: AbortSignal,
): Promise<RdfAnalysisResult> {
  const response = await fetch("/api/analysis/rdf", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      dataset_generation: request.datasetGeneration,
      reference_indices: request.referenceIndices,
      target_indices: request.targetIndices,
      frame_start: request.frameStart ?? 0,
      frame_stop: request.frameStop,
      frame_step: request.frameStep ?? 1,
      n_bins: request.bins ?? 200,
      r_max: request.rMax,
    }),
    signal,
  });
  if (response.status === 409) {
    throw new DatasetChangedError(
      await responseMessage(response, "Trajectory changed. Reloading."),
    );
  }
  if (!response.ok) {
    throw new Error(await responseMessage(response, "Could not run RDF analysis"));
  }
  return parseRdfAnalysisResult(await response.json(), request.datasetGeneration);
}

export async function openFiles(files: File[], signal?: AbortSignal): Promise<Manifest> {
  if (files.length === 0) throw new Error("Choose at least one trajectory file");
  const body = new FormData();
  files.forEach((file) => body.append("files", file, file.name));
  const response = await fetch("/api/open", {
    method: "POST",
    headers: { Accept: "application/json" },
    body,
    signal,
  });
  if (!response.ok) throw new Error(await responseMessage(response, "Could not open the files"));
  const result = (await response.json()) as Manifest | { manifest?: Manifest };
  const manifest = "manifest" in result && result.manifest ? result.manifest : result as Manifest;
  validateManifest(manifest, "The opened trajectory is incomplete");
  return manifest;
}

export class DatasetChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetChangedError";
  }
}

export async function getFrame(
  index: number,
  signal?: AbortSignal,
  datasetGeneration?: string,
  coordinates: FrameCoordinateMode = "source",
): Promise<FrameData> {
  const parameters: string[] = [];
  if (datasetGeneration) {
    parameters.push(`dataset_generation=${encodeURIComponent(datasetGeneration)}`);
  }
  if (coordinates === "unwrapped") parameters.push("coordinates=unwrapped");
  const query = parameters.length > 0 ? `?${parameters.join("&")}` : "";
  const response = await fetch(`/api/frames/${index}${query}`, {
    headers: { Accept: "application/octet-stream" },
    signal,
  });
  if (response.status === 409) {
    throw new DatasetChangedError(
      await responseMessage(response, "Trajectory changed. Reloading."),
    );
  }
  if (!response.ok) throw new Error(await responseMessage(response, `Could not load frame ${index + 1}`));
  return decodeFrame(await response.arrayBuffer());
}

export function decodeFrame(buffer: ArrayBuffer): FrameData {
  if (buffer.byteLength < 4) throw new Error("Frame packet is truncated");
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  const payloadStart = 4 + headerLength;
  if (payloadStart > buffer.byteLength) throw new Error("Frame header is truncated");

  let header: FrameHeader;
  try {
    header = JSON.parse(utf8.decode(new Uint8Array(buffer, 4, headerLength))) as FrameHeader;
  } catch {
    throw new Error("Frame header is invalid");
  }

  if (!Array.isArray(header.arrays)) throw new Error("Frame arrays are missing");
  const arrays = new Map<string, Float32Array | Int32Array>();
  for (const descriptor of header.arrays) {
    const start = payloadStart + descriptor.byte_offset;
    const end = start + descriptor.byte_length;
    if (start < payloadStart || end > buffer.byteLength || end < start) {
      throw new Error(`Array ${descriptor.name} is truncated`);
    }
    if (!isFloat32(descriptor.dtype) && !isInt32(descriptor.dtype)) {
      throw new Error(`Array ${descriptor.name} uses unsupported type ${descriptor.dtype}`);
    }
    const bytes = buffer.slice(start, end);
    arrays.set(
      descriptor.name.toLowerCase(),
      isInt32(descriptor.dtype) ? new Int32Array(bytes) : new Float32Array(bytes),
    );
  }
  return { header, arrays };
}

interface FrameCacheEntry {
  promise: Promise<FrameData>;
  controller: AbortController | null;
  byteLength: number;
  prefetch: boolean;
}

export interface FrameCacheOptions {
  maxFrames?: number;
  maxBytes?: number;
  datasetGeneration?: string;
  coordinates?: FrameCoordinateMode;
}

export class FrameCache {
  private readonly values = new Map<number, FrameCacheEntry>();
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  private readonly datasetGeneration?: string;
  private readonly coordinates: FrameCoordinateMode;
  private resolvedBytes = 0;
  private frameByteEstimate = 0;

  constructor(options: FrameCacheOptions = {}) {
    this.maxFrames = positiveInteger(options.maxFrames, DEFAULT_FRAME_CACHE_LIMIT);
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_FRAME_CACHE_BYTES);
    this.datasetGeneration = normalizedGeneration(options.datasetGeneration);
    this.coordinates = options.coordinates ?? "source";
  }

  get(index: number): Promise<FrameData> {
    const cached = this.values.get(index);
    if (cached) {
      cached.prefetch = false;
      this.values.delete(index);
      this.values.set(index, cached);
      return cached.promise;
    }
    return this.load(index, false);
  }

  prefetch(index: number, frameCount: number): void {
    if (
      index < 0
      || index >= frameCount
      || this.values.has(index)
      || !this.canPrefetch()
    ) {
      return;
    }
    void this.load(index, true).catch(() => {});
  }

  cancelPendingExcept(index: number): void {
    for (const [key, entry] of this.values) {
      if (key === index || !entry.controller) continue;
      this.remove(key, entry, true);
    }
  }

  clear(): void {
    for (const entry of this.values.values()) entry.controller?.abort();
    this.values.clear();
    this.resolvedBytes = 0;
    this.frameByteEstimate = 0;
  }

  private load(index: number, prefetch: boolean): Promise<FrameData> {
    const controller = new AbortController();
    let entry!: FrameCacheEntry;
    const promise = getFrame(index, controller.signal, this.datasetGeneration, this.coordinates)
      .then((frame) => {
        entry.controller = null;
        entry.byteLength = decodedFrameByteLength(frame);
        this.frameByteEstimate = Math.max(this.frameByteEstimate, entry.byteLength);
        if (this.values.get(index) === entry) {
          this.resolvedBytes += entry.byteLength;
          this.trim();
        }
        return frame;
      })
      .catch((error) => {
        if (this.values.get(index) === entry) this.remove(index, entry, false);
        throw error;
      });
    entry = { promise, controller, byteLength: 0, prefetch };
    this.values.set(index, entry);
    this.trim();
    return promise;
  }

  private canPrefetch(): boolean {
    const pendingPrefetches = [...this.values.values()].filter(
      (entry) => entry.prefetch && entry.controller !== null,
    ).length;
    if (this.frameByteEstimate === 0) {
      return pendingPrefetches < DEFAULT_PENDING_PREFETCH_LIMIT;
    }

    const residentCapacity = Math.floor(this.maxBytes / this.frameByteEstimate);
    const prefetchLimit = Math.min(
      DEFAULT_PENDING_PREFETCH_LIMIT,
      Math.max(0, residentCapacity - 1),
    );
    return pendingPrefetches < prefetchLimit;
  }

  private trim(): void {
    while (this.values.size > this.maxFrames || this.resolvedBytes > this.maxBytes) {
      const oldest = this.values.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      const entry = this.values.get(oldest);
      if (entry) this.remove(oldest, entry, true);
    }
  }

  private remove(index: number, entry: FrameCacheEntry, abort: boolean): void {
    if (this.values.get(index) !== entry) return;
    this.values.delete(index);
    this.resolvedBytes = Math.max(0, this.resolvedBytes - entry.byteLength);
    if (abort) entry.controller?.abort();
  }
}

function decodedFrameByteLength(frame: FrameData): number {
  const buffers = new Set<ArrayBufferLike>();
  let total = 0;
  for (const values of frame.arrays.values()) {
    const buffer = values.buffer;
    if (buffers.has(buffer)) continue;
    buffers.add(buffer);
    total += buffer.byteLength;
    if (!Number.isSafeInteger(total)) return Number.MAX_SAFE_INTEGER;
  }
  return total;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function validateManifest(manifest: Manifest, message: string): void {
  if (
    !manifest.topology
    || !Number.isFinite(manifest.frame_count)
    || normalizedGeneration(manifest.dataset_generation) === undefined
  ) {
    throw new Error(message);
  }
}

function parseSelectedPositions(
  value: unknown,
  request: SelectedPositionsRequest,
): SelectedPositions {
  if (!value || typeof value !== "object") {
    throw new Error("Selected positions response is invalid");
  }
  const raw = value as {
    schema_version?: unknown;
    dataset_generation?: unknown;
    atom_indices?: unknown;
    unit?: unknown;
    frames?: unknown;
  };
  const schemaVersion = finiteInteger(raw.schema_version, "position schema");
  const generation = requiredString(raw.dataset_generation, "position generation");
  if (generation !== request.datasetGeneration) {
    throw new DatasetChangedError("Trajectory changed. Reloading.");
  }
  const atomIndices = integerArray(raw.atom_indices, "position atoms");
  if (
    atomIndices.length !== request.atomIndices.length
    || atomIndices.some((atom, index) => atom !== request.atomIndices[index])
  ) {
    throw new Error("Selected positions do not match the requested atoms");
  }
  if (!Array.isArray(raw.frames) || raw.frames.length !== request.frameIndices.length) {
    throw new Error("Selected positions do not match the requested frames");
  }
  const frames = raw.frames.map((entry, sample): SelectedPositionFrame => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Selected position frame is invalid");
    }
    const frame = entry as {
      index?: unknown;
      key?: unknown;
      positions?: unknown;
      step?: unknown;
      time?: unknown;
      time_unit?: unknown;
    };
    const index = finiteInteger(frame.index, "position frame");
    if (index !== request.frameIndices[sample]) {
      throw new Error("Selected positions are out of order");
    }
    if (!Array.isArray(frame.positions) || frame.positions.length !== atomIndices.length) {
      throw new Error("Selected position coordinates are incomplete");
    }
    const positions = new Float32Array(atomIndices.length * 3);
    frame.positions.forEach((coordinates, atom) => {
      if (
        !Array.isArray(coordinates)
        || coordinates.length !== 3
        || !coordinates.every((coordinate) => (
          typeof coordinate === "number" && Number.isFinite(coordinate)
        ))
      ) {
        throw new Error("Selected position coordinates are invalid");
      }
      positions.set(coordinates as number[], atom * 3);
    });
    return Object.freeze({
      index,
      key: parseFrameKey(frame.key),
      positions,
      step: nullableFiniteNumber(frame.step),
      time: nullableFiniteNumber(frame.time),
      timeUnit: optionalString(frame.time_unit),
    });
  });
  return Object.freeze({
    schemaVersion,
    datasetGeneration: generation,
    atomIndices: Object.freeze([...atomIndices]),
    unit: requiredString(raw.unit, "position unit"),
    frames: Object.freeze(frames),
  });
}

function parseRdfAnalysisResult(
  value: unknown,
  expectedGeneration: string,
): RdfAnalysisResult {
  if (!value || typeof value !== "object") {
    throw new Error("RDF response is invalid");
  }
  const raw = value as Record<string, unknown>;
  const generation = requiredString(raw.dataset_generation, "RDF generation");
  if (generation !== expectedGeneration) {
    throw new DatasetChangedError("Trajectory changed. Reloading.");
  }
  const frameRangeRaw = raw.frame_range;
  if (!frameRangeRaw || typeof frameRangeRaw !== "object") {
    throw new Error("RDF frame identity is missing");
  }
  const range = frameRangeRaw as Record<string, unknown>;
  const frameRange: RdfFrameRange = Object.freeze({
    start: finiteInteger(range.start, "RDF frame start"),
    stop: finiteInteger(range.stop, "RDF frame stop"),
    step: positiveIntegerValue(range.step, "RDF frame step"),
    count: positiveIntegerValue(range.count, "RDF frame count"),
    firstKey: parseFrameKey(range.first_key),
    lastKey: parseFrameKey(range.last_key),
  });
  const radiusCenters = numberArray(raw.radius_centers, "RDF radius");
  const gR = numberArray(raw.g_r, "RDF values");
  const coordinationRadius = numberArray(
    raw.coordination_radius,
    "coordination radius",
  );
  const coordination = numberArray(raw.coordination, "coordination values");
  if (
    radiusCenters.length !== gR.length
    || coordinationRadius.length !== coordination.length
    || radiusCenters.length !== coordination.length
  ) {
    throw new Error("RDF result arrays are misaligned");
  }
  const units = raw.units;
  if (!units || typeof units !== "object") {
    throw new Error("RDF units are missing");
  }
  const unitValues = units as Record<string, unknown>;
  const parameters = raw.parameters;
  if (!parameters || typeof parameters !== "object") {
    throw new Error("RDF parameters are missing");
  }
  const parameterValues = parameters as Record<string, unknown>;
  const selections = raw.selections;
  if (!selections || typeof selections !== "object") {
    throw new Error("RDF selections are missing");
  }
  const selectionValues = selections as Record<string, unknown>;
  return Object.freeze({
    schemaVersion: finiteInteger(raw.schema_version, "RDF schema"),
    datasetGeneration: generation,
    referenceIndices: Object.freeze(integerArray(
      selectionValues.reference_indices,
      "RDF reference selection",
    )),
    targetIndices: Object.freeze(integerArray(
      selectionValues.target_indices,
      "RDF target selection",
    )),
    frameRange,
    radiusUnit: requiredString(unitValues.radius, "RDF radius unit"),
    rdfUnit: requiredString(unitValues.g_r, "RDF unit"),
    coordinationUnit: requiredString(
      unitValues.coordination,
      "coordination unit",
    ),
    bins: positiveIntegerValue(parameterValues.n_bins, "RDF bins"),
    rMax: positiveNumber(parameterValues.r_max, "RDF maximum radius"),
    deltaR: positiveNumber(parameterValues.delta_r, "RDF resolution"),
    radiusCenters: Object.freeze(radiusCenters),
    gR: Object.freeze(gR),
    coordinationRadius: Object.freeze(coordinationRadius),
    coordination: Object.freeze(coordination),
    pqAnalysisVersion: optionalString(raw.pqanalysis_version) ?? undefined,
    elapsedSeconds: nullableFiniteNumber(raw.elapsed_seconds) ?? undefined,
  });
}

function parseFrameKey(value: unknown): FrameKey {
  if (!value || typeof value !== "object") {
    throw new Error("Frame key is invalid");
  }
  const key = value as Record<string, unknown>;
  return Object.freeze({
    source_id: requiredString(key.source_id, "frame source"),
    source_index: finiteInteger(key.source_index, "frame source index"),
    segment_index: finiteInteger(key.segment_index, "frame segment"),
    step: nullableFiniteNumber(key.step),
    time: nullableFiniteNumber(key.time),
    time_unit: optionalString(key.time_unit),
  });
}

function integerArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} are invalid`);
  return value.map((entry) => finiteInteger(entry, label));
}

function numberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} are invalid`);
  return value.map((entry) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new Error(`${label} are invalid`);
    }
    return entry;
  });
}

function finiteInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function positiveIntegerValue(value: unknown, label: string): number {
  const result = finiteInteger(value, label);
  if (result < 1) throw new Error(`${label} is invalid`);
  return result;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedGeneration(value: string | undefined): string | undefined {
  const generation = value?.trim();
  return generation ? generation : undefined;
}

export function frameArray(frame: FrameData | null, names: string[]): Float32Array | null {
  if (!frame) return null;
  for (const name of names) {
    const value = frame.arrays.get(name.toLowerCase());
    if (value instanceof Float32Array) return value;
  }
  return null;
}

export function frameIntArray(frame: FrameData | null, names: string[]): Int32Array | null {
  if (!frame) return null;
  for (const name of names) {
    const value = frame.arrays.get(name.toLowerCase());
    if (value instanceof Int32Array) return value;
  }
  return null;
}

export function normalizeSeries(input: Manifest["series"]): DisplaySeries[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .filter((entry): entry is SeriesSpec => Boolean(entry && Array.isArray(entry.values)))
      .map((entry, index) => ({
        name: entry.name ?? entry.key ?? `series-${index + 1}`,
        label: entry.label ?? title(entry.name ?? entry.key ?? `Series ${index + 1}`),
        unit: entry.unit,
        values: numericValues(entry.values),
      }));
  }

  const result: DisplaySeries[] = [];
  for (const [name, raw] of Object.entries(input)) {
    if (Array.isArray(raw)) {
      result.push({ name, label: title(name), values: numericValues(raw) });
      continue;
    }
    if (raw && typeof raw === "object" && Array.isArray((raw as SeriesSpec).values)) {
      const entry = raw as SeriesSpec;
      result.push({
        name,
        label: entry.label ?? title(entry.name ?? name),
        unit: entry.unit,
        values: numericValues(entry.values),
      });
    }
  }
  return result;
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string; message?: string };
    return body.detail ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

function isFloat32(dtype: string): boolean {
  return ["float32", "f4", "<f4", "float", "single"].includes(dtype.toLowerCase());
}

function isInt32(dtype: string): boolean {
  return ["int32", "i4", "<i4", "int"].includes(dtype.toLowerCase());
}

function numericValues(values: unknown[]): Array<number | null> {
  return values.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : null));
}

function title(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
