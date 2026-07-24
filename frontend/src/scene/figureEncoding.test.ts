import { describe, expect, it } from "vitest";
import { encodeFigurePng, encodeFigureTiff } from "./figureEncoding";

const rgba = new Uint8Array([
  255, 0, 0, 255, 0, 255, 0, 128,
  0, 0, 255, 0, 255, 255, 255, 255,
]);

describe("figure PNG encoding", () => {
  it("writes top-left RGBA pixels, exact dimensions and DPI metadata", async () => {
    const blob = await encodeFigurePng(rgba, { width: 2, height: 2, dpi: 300 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks = pngChunks(bytes);

    expect(blob.type).toBe("image/png");
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(chunks.map(({ type }) => type)).toEqual([
      "IHDR",
      "sRGB",
      "pHYs",
      "tEXt",
      "IDAT",
      "IEND",
    ]);
    const ihdr = chunks[0].data;
    expect(new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength).getUint32(0)).toBe(2);
    expect(new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength).getUint32(4)).toBe(2);
    expect([...ihdr.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    expect([...chunks.find(({ type }) => type === "sRGB")!.data]).toEqual([0]);

    const resolution = chunks.find(({ type }) => type === "pHYs")!.data;
    const resolutionView = new DataView(
      resolution.buffer,
      resolution.byteOffset,
      resolution.byteLength,
    );
    expect(resolutionView.getUint32(0)).toBe(11811);
    expect(resolutionView.getUint32(4)).toBe(11811);
    expect(resolution[8]).toBe(1);
    expect(new TextDecoder().decode(chunks.find(({ type }) => type === "tEXt")!.data))
      .toBe("DPI\u0000300");

    for (const chunk of chunks) expect(chunk.crc).toBe(chunk.calculatedCrc);
    const compressed = concatenate(
      chunks.filter(({ type }) => type === "IDAT").map(({ data }) => data),
    );
    const scanlines = await inflate(compressed);
    expect([...scanlines]).toEqual([
      0, ...rgba.subarray(0, 8),
      0, ...rgba.subarray(8, 16),
    ]);
  });

  it("rejects invalid dimensions, DPI and pixel buffers", async () => {
    await expect(encodeFigurePng(rgba, { width: 0, height: 2, dpi: 300 }))
      .rejects.toThrow("width must be a positive integer");
    await expect(encodeFigurePng(rgba, { width: 2, height: 2, dpi: 0 }))
      .rejects.toThrow("DPI must be between");
    await expect(encodeFigurePng(rgba.subarray(0, 8), { width: 2, height: 2, dpi: 300 }))
      .rejects.toThrow("exactly 16 bytes");
  });
});

describe("figure TIFF encoding", () => {
  it("writes baseline RGBA with top-left orientation and exact rational DPI", async () => {
    const blob = encodeFigureTiff(rgba, { width: 2, height: 2, dpi: 72.5 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tags = tiffTags(view);

    expect(blob.type).toBe("image/tiff");
    expect(new TextDecoder().decode(bytes.subarray(0, 2))).toBe("II");
    expect(view.getUint16(2, true)).toBe(42);
    expect(tiffValue(view, tags.get(256)!)).toBe(2);
    expect(tiffValue(view, tags.get(257)!)).toBe(2);
    expect(tiffValue(view, tags.get(259)!)).toBe(32773);
    expect(tiffValue(view, tags.get(262)!)).toBe(2);
    expect(tiffValue(view, tags.get(274)!)).toBe(1);
    expect(tiffValue(view, tags.get(277)!)).toBe(4);
    expect(tiffValue(view, tags.get(278)!)).toBe(2);
    expect(tiffValue(view, tags.get(284)!)).toBe(1);
    expect(tiffValue(view, tags.get(296)!)).toBe(2);
    expect(tiffValue(view, tags.get(338)!)).toBe(2);
    const profile = tags.get(34675)!;
    expect(profile.type).toBe(7);
    expect(profile.count).toBeGreaterThan(128);
    const profileBytes = bytes.subarray(profile.value, profile.value + profile.count);
    const profileView = new DataView(
      profileBytes.buffer,
      profileBytes.byteOffset,
      profileBytes.byteLength,
    );
    expect(profileView.getUint32(0)).toBe(profileBytes.length);
    expect(new TextDecoder().decode(profileBytes.subarray(12, 24))).toBe("mntrRGB XYZ ");
    expect(new TextDecoder().decode(profileBytes.subarray(36, 40))).toBe("acsp");

    const bits = tags.get(258)!;
    expect(Array.from(
      { length: 4 },
      (_, index) => view.getUint16(bits.value + index * 2, true),
    )).toEqual([8, 8, 8, 8]);
    const xResolution = tags.get(282)!.value;
    const yResolution = tags.get(283)!.value;
    expect([
      view.getUint32(xResolution, true),
      view.getUint32(xResolution + 4, true),
    ]).toEqual([145, 2]);
    expect([
      view.getUint32(yResolution, true),
      view.getUint32(yResolution + 4, true),
    ]).toEqual([145, 2]);

    const stripOffset = tiffValue(view, tags.get(273)!);
    const stripBytes = tiffValue(view, tags.get(279)!);
    expect([...unpackBits(bytes.subarray(stripOffset, stripOffset + stripBytes))])
      .toEqual([...rgba]);
  });

  it("compresses repeated backgrounds and validates the RGBA contract", async () => {
    const solid = new Uint8Array(64 * 64 * 4);
    solid.fill(255);
    const blob = encodeFigureTiff(solid, { width: 64, height: 64, dpi: 300 });

    expect(blob.size).toBeLessThan(solid.length / 4);
    expect(() => encodeFigureTiff(solid.subarray(0, 8), {
      width: 64,
      height: 64,
      dpi: 300,
    })).toThrow("exactly 16384 bytes");
  });

  it("round-trips PackBits run and literal boundaries", async () => {
    const patterns = [
      new Uint8Array(129 * 4).fill(23),
      Uint8Array.from({ length: 130 * 4 }, (_, index) => index % 251),
      Uint8Array.from({ length: 132 * 4 }, (_, index) => (
        Math.floor(index / 3) % 2 === 0 ? 7 : index % 256
      )),
    ];
    for (const pixels of patterns) {
      const blob = encodeFigureTiff(pixels, {
        width: pixels.length / 4,
        height: 1,
        dpi: 300,
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const tags = tiffTags(view);
      const stripOffset = tiffValue(view, tags.get(273)!);
      const stripBytes = tiffValue(view, tags.get(279)!);
      expect([...unpackBits(bytes.subarray(stripOffset, stripOffset + stripBytes))])
        .toEqual([...pixels]);
    }
  });

  it("starts a new PackBits packet stream for every row", async () => {
    const pixels = Uint8Array.from({ length: 3 * 4 * 3 }, (_, index) => (
      index % 11
    ));
    const blob = encodeFigureTiff(pixels, {
      width: 3,
      height: 3,
      dpi: 300,
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tags = tiffTags(view);
    const stripOffset = tiffValue(view, tags.get(273)!);
    const stripBytes = tiffValue(view, tags.get(279)!);

    expect([...unpackBitsRows(
      bytes.subarray(stripOffset, stripOffset + stripBytes),
      3 * 4,
      3,
    )]).toEqual([...pixels]);
  });

  it("rejects a TIFF resolution that rounds to a zero rational", () => {
    expect(() => encodeFigureTiff(
      new Uint8Array([0, 0, 0, 0]),
      { width: 1, height: 1, dpi: Number.MIN_VALUE },
    )).toThrow("TIFF DPI is outside the supported range");
  });
});

interface PngChunk {
  type: string;
  data: Uint8Array;
  crc: number;
  calculatedCrc: number;
}

function pngChunks(bytes: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    chunks.push({
      type,
      data,
      crc: view.getUint32(offset + 8 + length),
      calculatedCrc: crc32(bytes.subarray(offset + 4, offset + 8 + length)),
    });
    offset += 12 + length;
  }
  return chunks;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const stream = new Blob([input])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb8_8320 : 0);
    }
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

interface TiffTag {
  type: number;
  count: number;
  value: number;
  entryOffset: number;
}

function tiffTags(view: DataView): Map<number, TiffTag> {
  const ifd = view.getUint32(4, true);
  const count = view.getUint16(ifd, true);
  const tags = new Map<number, TiffTag>();
  for (let index = 0; index < count; index += 1) {
    const offset = ifd + 2 + index * 12;
    tags.set(view.getUint16(offset, true), {
      type: view.getUint16(offset + 2, true),
      count: view.getUint32(offset + 4, true),
      value: view.getUint32(offset + 8, true),
      entryOffset: offset,
    });
  }
  return tags;
}

function tiffValue(view: DataView, tag: TiffTag): number {
  return tag.type === 3 && tag.count === 1
    ? view.getUint16(tag.entryOffset + 8, true)
    : tag.value;
}

function unpackBits(bytes: Uint8Array): Uint8Array {
  const output: number[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const header = bytes[offset++];
    if (header <= 127) {
      const count = header + 1;
      output.push(...bytes.subarray(offset, offset + count));
      offset += count;
    } else if (header >= 129) {
      const count = 257 - header;
      output.push(...Array<number>(count).fill(bytes[offset++]));
    }
  }
  return Uint8Array.from(output);
}

function unpackBitsRows(
  bytes: Uint8Array,
  rowBytes: number,
  height: number,
): Uint8Array {
  const output = new Uint8Array(rowBytes * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    let rowOffset = row * rowBytes;
    const rowEnd = rowOffset + rowBytes;
    while (rowOffset < rowEnd) {
      const header = bytes[sourceOffset++];
      if (header <= 127) {
        const count = header + 1;
        if (rowOffset + count > rowEnd) throw new Error("PackBits packet crosses a row");
        output.set(bytes.subarray(sourceOffset, sourceOffset + count), rowOffset);
        sourceOffset += count;
        rowOffset += count;
      } else if (header >= 129) {
        const count = 257 - header;
        if (rowOffset + count > rowEnd) throw new Error("PackBits run crosses a row");
        output.fill(bytes[sourceOffset++], rowOffset, rowOffset + count);
        rowOffset += count;
      }
    }
  }
  expect(sourceOffset).toBe(bytes.length);
  return output;
}
