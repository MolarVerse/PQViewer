import type { DisplaySeries, FrameData, FrameHeader, Manifest, SeriesSpec } from "./types";

const utf8 = new TextDecoder();
const DEFAULT_FRAME_CACHE_LIMIT = 96;
const DEFAULT_FRAME_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_PENDING_PREFETCH_LIMIT = 4;

export type FrameCoordinateMode = "source" | "unwrapped";

export async function getManifest(): Promise<Manifest> {
  const response = await fetch("/api/manifest", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(await responseMessage(response, "Could not load the trajectory"));
  const manifest = (await response.json()) as Manifest;
  validateManifest(manifest, "The trajectory manifest is incomplete");
  return manifest;
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
