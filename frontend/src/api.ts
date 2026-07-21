import type { DisplaySeries, FrameData, FrameHeader, Manifest, SeriesSpec } from "./types";

const utf8 = new TextDecoder();

export async function getManifest(): Promise<Manifest> {
  const response = await fetch("/api/manifest", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(await responseMessage(response, "Could not load the trajectory"));
  const manifest = (await response.json()) as Manifest;
  if (!manifest.topology || !Number.isFinite(manifest.frame_count)) {
    throw new Error("The trajectory manifest is incomplete");
  }
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
  if (!manifest.topology || !Number.isFinite(manifest.frame_count)) {
    throw new Error("The opened trajectory is incomplete");
  }
  return manifest;
}

export async function getFrame(index: number, signal?: AbortSignal): Promise<FrameData> {
  const response = await fetch(`/api/frames/${index}`, {
    headers: { Accept: "application/octet-stream" },
    signal,
  });
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
  const arrays = new Map<string, Float32Array>();
  for (const descriptor of header.arrays) {
    const start = payloadStart + descriptor.byte_offset;
    const end = start + descriptor.byte_length;
    if (start < payloadStart || end > buffer.byteLength || end < start) {
      throw new Error(`Array ${descriptor.name} is truncated`);
    }
    if (!isFloat32(descriptor.dtype)) {
      throw new Error(`Array ${descriptor.name} uses unsupported type ${descriptor.dtype}`);
    }
    const bytes = buffer.slice(start, end);
    arrays.set(descriptor.name.toLowerCase(), new Float32Array(bytes));
  }
  return { header, arrays };
}

export class FrameCache {
  private readonly values = new Map<number, { promise: Promise<FrameData>; controller: AbortController | null }>();
  private readonly limit = 96;

  get(index: number): Promise<FrameData> {
    const cached = this.values.get(index);
    if (cached) {
      this.values.delete(index);
      this.values.set(index, cached);
      return cached.promise;
    }
    const controller = new AbortController();
    let entry!: { promise: Promise<FrameData>; controller: AbortController | null };
    const promise = getFrame(index, controller.signal)
      .then((frame) => {
        entry.controller = null;
        return frame;
      })
      .catch((error) => {
        if (this.values.get(index) === entry) this.values.delete(index);
        throw error;
      });
    entry = { promise, controller };
    this.values.set(index, entry);
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    return entry.promise;
  }

  prefetch(index: number, frameCount: number): void {
    if (index >= 0 && index < frameCount && !this.values.has(index)) void this.get(index).catch(() => {});
  }

  cancelPendingExcept(index: number): void {
    for (const [key, entry] of this.values) {
      if (key === index || !entry.controller) continue;
      entry.controller.abort();
      this.values.delete(key);
    }
  }

  clear(): void {
    for (const entry of this.values.values()) entry.controller?.abort();
    this.values.clear();
  }
}

export function frameArray(frame: FrameData | null, names: string[]): Float32Array | null {
  if (!frame) return null;
  for (const name of names) {
    const value = frame.arrays.get(name.toLowerCase());
    if (value) return value;
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

function numericValues(values: unknown[]): Array<number | null> {
  return values.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : null));
}

function title(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
