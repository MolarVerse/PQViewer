export interface PngExportOptions {
  width: number;
  height: number;
  transparent?: boolean;
  fit?: boolean;
  projection?: "orthographic" | "perspective";
  periodicContext?: boolean;
  /** Fraction of the frame reserved on each edge when fitting. */
  padding?: number;
}

export interface ResolvedPngExportOptions {
  width: number;
  height: number;
  transparent: boolean;
  fit: boolean;
  projection: "orthographic" | "perspective";
  periodicContext: boolean;
  padding: number;
}

export interface PngExportLimits {
  maxWidth: number;
  maxHeight: number;
  maxPixels?: number;
}

export const DEFAULT_PNG_EXPORT_PADDING = 0.08;
export const MAX_PNG_EXPORT_PIXELS = 24_000_000;

export function resolvePngExportOptions(
  options: PngExportOptions,
  limits: PngExportLimits,
): ResolvedPngExportOptions {
  const width = positiveInteger(options.width, "width");
  const height = positiveInteger(options.height, "height");
  const maxWidth = positiveInteger(limits.maxWidth, "maximum width");
  const maxHeight = positiveInteger(limits.maxHeight, "maximum height");
  const maxPixels = limits.maxPixels ?? MAX_PNG_EXPORT_PIXELS;
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) throw new Error("PNG export pixel limit is invalid");
  if (width > maxWidth || height > maxHeight) {
    throw new Error(`PNG export exceeds the WebGL limit of ${maxWidth} × ${maxHeight} px`);
  }
  if (width * height > maxPixels) {
    throw new Error(`PNG export exceeds the ${maxPixels.toLocaleString("en")} pixel safety limit`);
  }
  const padding = options.padding ?? DEFAULT_PNG_EXPORT_PADDING;
  if (!Number.isFinite(padding) || padding < 0 || padding > 0.4) {
    throw new Error("PNG export padding must be between 0 and 0.4");
  }
  return {
    width,
    height,
    transparent: options.transparent ?? false,
    fit: options.fit ?? true,
    projection: options.projection ?? "orthographic",
    periodicContext: options.periodicContext ?? true,
    padding,
  };
}

/** Number of jittered samples expressed as 2^level. */
export function pngExportSampleLevel(pixelCount: number): number {
  if (!Number.isFinite(pixelCount) || pixelCount <= 0) return 0;
  if (pixelCount <= 5_000_000) return 3;
  if (pixelCount <= 8_000_000) return 2;
  if (pixelCount <= 12_000_000) return 1;
  return 0;
}

/** Fractional AO buffer size. Large renders skip AO to protect GPU memory. */
export function pngExportAoScale(pixelCount: number): number {
  if (!Number.isFinite(pixelCount) || pixelCount <= 0) return 0;
  if (pixelCount <= 8_000_000) return 0.5;
  if (pixelCount <= 12_000_000) return 0.35;
  return 0;
}

export function hasVisiblePngContent(pixels: Uint8Array, transparent: boolean): boolean {
  if (pixels.length < 4 || pixels.length % 4 !== 0) return false;
  if (transparent) {
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] > 1) return true;
    }
    return false;
  }
  let minRed = 255;
  let minGreen = 255;
  let minBlue = 255;
  let maxRed = 0;
  let maxGreen = 0;
  let maxBlue = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    minRed = Math.min(minRed, pixels[offset]);
    minGreen = Math.min(minGreen, pixels[offset + 1]);
    minBlue = Math.min(minBlue, pixels[offset + 2]);
    maxRed = Math.max(maxRed, pixels[offset]);
    maxGreen = Math.max(maxGreen, pixels[offset + 1]);
    maxBlue = Math.max(maxBlue, pixels[offset + 2]);
  }
  return maxRed - minRed > 2 || maxGreen - minGreen > 2 || maxBlue - minBlue > 2;
}

export function flipRgbaRowsInPlace(pixels: Uint8Array, width: number, height: number): void {
  const rowLength = width * 4;
  if (pixels.length !== rowLength * height) throw new Error("PNG pixel buffer has an unexpected size");
  const row = new Uint8Array(rowLength);
  for (let top = 0; top < Math.floor(height / 2); top += 1) {
    const bottom = height - top - 1;
    const topOffset = top * rowLength;
    const bottomOffset = bottom * rowLength;
    row.set(pixels.subarray(topOffset, topOffset + rowLength));
    pixels.copyWithin(topOffset, bottomOffset, bottomOffset + rowLength);
    pixels.set(row, bottomOffset);
  }
}

export async function encodeRgbaPng(pixels: Uint8Array, width: number, height: number): Promise<Blob> {
  flipRgbaRowsInPlace(pixels, width, height);
  const clamped = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PNG encoder is unavailable");
    const image = context.createImageData(width, height);
    image.data.set(clamped);
    context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    if (blob.size === 0) throw new Error("PNG encoder returned an empty file");
    return blob;
  }
  if (typeof document === "undefined") throw new Error("PNG encoder is unavailable");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PNG encoder is unavailable");
  const image = context.createImageData(width, height);
  image.data.set(clamped);
  context.putImageData(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encoding failed")), "image/png");
  });
  if (blob.size === 0) throw new Error("PNG encoder returned an empty file");
  return blob;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`PNG export ${label} must be a positive integer`);
  return value;
}
