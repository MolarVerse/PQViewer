import { describe, expect, it } from "vitest";
import {
  flipRgbaRowsInPlace,
  hasVisiblePngContent,
  MAX_PNG_EXPORT_PIXELS,
  pngExportSampleCount,
  resolvePngExportOptions,
  unpremultiplyRgbaInPlace,
} from "./pngExport";

const limits = { maxWidth: 8192, maxHeight: 8192, maxPixels: MAX_PNG_EXPORT_PIXELS };

describe("PNG export options", () => {
  it("resolves publication defaults without changing requested dimensions", () => {
    expect(resolvePngExportOptions({ width: 6000, height: 4000 }, limits)).toEqual({
      width: 6000,
      height: 4000,
      transparent: false,
      fit: false,
      padding: 0.08,
    });
  });

  it("rejects invalid dimensions, GPU limits and unsafe pixel counts", () => {
    expect(() => resolvePngExportOptions({ width: 0, height: 100 }, limits)).toThrow(/positive integer/);
    expect(() => resolvePngExportOptions({ width: 9000, height: 100 }, limits)).toThrow(/WebGL limit/);
    expect(() => resolvePngExportOptions({ width: 8000, height: 5000 }, limits)).toThrow(/safety limit/);
  });

  it("validates fit padding and scales multisampling by image size", () => {
    expect(resolvePngExportOptions({ width: 2000, height: 1000, fit: true, padding: 0.15 }, limits).padding).toBe(0.15);
    expect(() => resolvePngExportOptions({ width: 2000, height: 1000, padding: 0.5 }, limits)).toThrow(/padding/);
    expect(pngExportSampleCount(3_000_000, 8)).toBe(4);
    expect(pngExportSampleCount(10_000_000, 8)).toBe(2);
    expect(pngExportSampleCount(24_000_000, 8)).toBe(0);
  });
});

describe("PNG pixel validation", () => {
  it("distinguishes empty transparent and flat opaque output", () => {
    expect(hasVisiblePngContent(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]), true)).toBe(false);
    expect(hasVisiblePngContent(new Uint8Array([20, 40, 60, 255, 20, 40, 60, 255]), false)).toBe(false);
    expect(hasVisiblePngContent(new Uint8Array([20, 40, 60, 255, 80, 40, 60, 255]), false)).toBe(true);
  });

  it("flips WebGL rows for PNG encoding", () => {
    const pixels = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8,
      9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    flipRgbaRowsInPlace(pixels, 2, 2);
    expect([...pixels]).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16,
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("restores straight RGB values for transparent PNG pixels", () => {
    const pixels = new Uint8Array([
      32, 64, 96, 128,
      20, 30, 40, 255,
      8, 9, 10, 0,
    ]);
    unpremultiplyRgbaInPlace(pixels);
    expect([...pixels]).toEqual([
      64, 128, 191, 128,
      20, 30, 40, 255,
      0, 0, 0, 0,
    ]);
  });
});
