const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const UINT32_MAX = 0xffff_ffff;
const CRC32_TABLE = buildCrc32Table();
const SRGB_ICC_PROFILE = decodeBase64(
  "AAACTGxjbXMEQAAAbW50clJHQiBYWVogB+oABwAYABEAGwABYWNzcEFQUEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA2Y3BydAAAAUAAAABMd3RwdAAAAYwAAAAUY2hhZAAAAaAAAAAsclhZWgAAAcwAAAAUYlhZWgAAAeAAAAAUZ1hZWgAAAfQAAAAUclRSQwAAAggAAAAgZ1RSQwAAAggAAAAgYlRSQwAAAggAAAAgY2hybQAAAigAAAAkbWx1YwAAAAAAAAABAAAADGVuVVMAAAAaAAAAHABzAFIARwBCACAAYgB1AGkAbAB0AC0AaQBuAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAADAAAAAcAE4AbwAgAGMAbwBwAHkAcgBpAGcAaAB0ACwAIAB1AHMAZQAgAGYAcgBlAGUAbAB5WFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDEIAAAXe///zJQAAB5MAAP2Q///7of///aIAAAPcAADAblhZWiAAAAAAAABvoAAAOPUAAAOQWFlaIAAAAAAAACSfAAAPhAAAtsNYWVogAAAAAAAAYpcAALeHAAAY2XBhcmEAAAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbY2hybQAAAAAAAwAAAACj1wAAVHsAAEzNAACZmgAAJmYAAA9c",
);

export interface FigureRasterOptions {
  width: number;
  height: number;
  dpi: number;
}

/**
 * Encode top-left RGBA pixels as a PNG with physical-resolution metadata.
 *
 * PNG stores resolution as integer pixels per metre. The exact requested DPI
 * is also retained in a text field because the standard pHYs value is
 * necessarily rounded.
 */
export async function encodeFigurePng(
  rgba: Uint8Array,
  options: FigureRasterOptions,
): Promise<Blob> {
  const { width, height, dpi } = validateRaster(rgba, options);
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  const rowBytes = width * 4;
  for (let row = 0; row < height; row += 1) {
    const target = row * (rowBytes + 1);
    scanlines[target] = 0;
    scanlines.set(
      rgba.subarray(row * rowBytes, (row + 1) * rowBytes),
      target + 1,
    );
  }

  const pixelsPerMetre = Math.round(dpi / 0.0254);
  if (pixelsPerMetre <= 0 || pixelsPerMetre > UINT32_MAX) {
    throw new Error("PNG DPI is outside the supported range");
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;

  const resolution = new Uint8Array(9);
  const resolutionView = new DataView(resolution.buffer);
  resolutionView.setUint32(0, pixelsPerMetre);
  resolutionView.setUint32(4, pixelsPerMetre);
  resolution[8] = 1;

  const exactDpi = new TextEncoder().encode(`DPI\0${dpi.toString()}`);
  const compressed = await deflate(scanlines);
  return partsBlob([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("sRGB", new Uint8Array([0])),
    pngChunk("pHYs", resolution),
    pngChunk("tEXt", exactDpi),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ], "image/png");
}

/**
 * Encode top-left RGBA pixels as a baseline little-endian TIFF.
 *
 * Pixels use chunky RGB with unassociated alpha. PackBits keeps the encoder
 * dependency-free and substantially reduces common solid backgrounds.
 */
export function encodeFigureTiff(
  rgba: Uint8Array,
  options: FigureRasterOptions,
): Blob {
  const { width, height, dpi } = validateRaster(rgba, options);
  const pixels = packBitsRows(rgba, width * 4, height);
  const [dpiNumerator, dpiDenominator] = dpiRational(dpi);
  const software = new TextEncoder().encode("PQViewer\0");
  if (dpiNumerator === 0) throw new Error("TIFF DPI is outside the supported range");
  const entryCount = 17;
  const ifdOffset = 8;
  const ifdBytes = 2 + entryCount * 12 + 4;
  const bitsOffset = ifdOffset + ifdBytes;
  const xResolutionOffset = bitsOffset + 8;
  const yResolutionOffset = xResolutionOffset + 8;
  const softwareOffset = yResolutionOffset + 8;
  const profileOffset = alignFour(softwareOffset + software.length);
  const pixelOffset = alignEven(profileOffset + SRGB_ICC_PROFILE.length);
  const totalBytes = pixelOffset + pixels.length;
  if (totalBytes > UINT32_MAX) throw new Error("TIFF output exceeds the 4 GiB baseline limit");

  const output = new Uint8Array(totalBytes);
  const view = new DataView(output.buffer);
  output[0] = 0x49;
  output[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entryCount, true);

  const entries: Array<[number, number, number, number]> = [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 4, bitsOffset],
    [259, 3, 1, 32773],
    [262, 3, 1, 2],
    [273, 4, 1, pixelOffset],
    [274, 3, 1, 1],
    [277, 3, 1, 4],
    [278, 4, 1, height],
    [279, 4, 1, pixels.length],
    [282, 5, 1, xResolutionOffset],
    [283, 5, 1, yResolutionOffset],
    [284, 3, 1, 1],
    [296, 3, 1, 2],
    [305, 2, software.length, softwareOffset],
    [338, 3, 1, 2],
    [34675, 7, SRGB_ICC_PROFILE.length, profileOffset],
  ];
  entries.forEach(([tag, type, count, value], index) => {
    const offset = ifdOffset + 2 + index * 12;
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    if (type === 3 && count === 1) {
      view.setUint16(offset + 8, value, true);
      view.setUint16(offset + 10, 0, true);
    } else {
      view.setUint32(offset + 8, value, true);
    }
  });
  view.setUint32(ifdOffset + 2 + entryCount * 12, 0, true);
  for (let index = 0; index < 4; index += 1) {
    view.setUint16(bitsOffset + index * 2, 8, true);
  }
  view.setUint32(xResolutionOffset, dpiNumerator, true);
  view.setUint32(xResolutionOffset + 4, dpiDenominator, true);
  view.setUint32(yResolutionOffset, dpiNumerator, true);
  view.setUint32(yResolutionOffset + 4, dpiDenominator, true);
  output.set(software, softwareOffset);
  output.set(SRGB_ICC_PROFILE, profileOffset);
  output.set(pixels, pixelOffset);
  return bytesBlob(output, "image/tiff");
}

function validateRaster(
  rgba: Uint8Array,
  { width, height, dpi }: FigureRasterOptions,
): Required<FigureRasterOptions> {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new Error("Figure width must be a positive integer");
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new Error("Figure height must be a positive integer");
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > Math.floor(Number.MAX_SAFE_INTEGER / 4)) {
    throw new Error("Figure dimensions are too large");
  }
  if (rgba.length !== pixelCount * 4) {
    throw new Error(`Figure RGBA buffer must contain exactly ${pixelCount * 4} bytes`);
  }
  if (!Number.isFinite(dpi) || dpi <= 0 || dpi > 1_000_000) {
    throw new Error("Figure DPI must be between 0 and 1,000,000");
  }
  return { width, height, dpi };
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("PNG chunk type is invalid");
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(8 + data.length, crc32(output.subarray(4, 8 + data.length)));
  return output;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffff_ffff) >>> 0;
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb8_8320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== "undefined") {
    const stream = new Blob([arrayBufferPart(bytes)])
      .stream()
      .pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return storedDeflate(bytes);
}

function storedDeflate(bytes: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(bytes.length / 0xffff));
  const output = new Uint8Array(2 + blockCount * 5 + bytes.length + 4);
  output[0] = 0x78;
  output[1] = 0x01;
  let sourceOffset = 0;
  let targetOffset = 2;
  for (let block = 0; block < blockCount; block += 1) {
    const length = Math.min(0xffff, bytes.length - sourceOffset);
    output[targetOffset] = block === blockCount - 1 ? 1 : 0;
    output[targetOffset + 1] = length & 0xff;
    output[targetOffset + 2] = length >>> 8;
    const complement = (~length) & 0xffff;
    output[targetOffset + 3] = complement & 0xff;
    output[targetOffset + 4] = complement >>> 8;
    targetOffset += 5;
    output.set(bytes.subarray(sourceOffset, sourceOffset + length), targetOffset);
    sourceOffset += length;
    targetOffset += length;
  }
  const checksum = adler32(bytes);
  const view = new DataView(output.buffer);
  view.setUint32(targetOffset, checksum);
  return output;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function packBitsRows(bytes: Uint8Array, rowBytes: number, height: number): Uint8Array {
  const maximumRowBytes = rowBytes + Math.ceil(rowBytes / 128) + 1;
  const output = new Uint8Array(maximumRowBytes * height);
  let target = 0;
  for (let row = 0; row < height; row += 1) {
    target = packBitsRange(
      bytes,
      row * rowBytes,
      (row + 1) * rowBytes,
      output,
      target,
    );
  }
  return output.subarray(0, target);
}

function packBitsRange(
  bytes: Uint8Array,
  startOffset: number,
  endOffset: number,
  output: Uint8Array,
  targetOffset: number,
): number {
  let index = startOffset;
  let target = targetOffset;
  while (index < endOffset) {
    let run = 1;
    while (
      run < 128
      && index + run < endOffset
      && bytes[index + run] === bytes[index]
    ) {
      run += 1;
    }
    if (run >= 3) {
      output[target++] = 257 - run;
      output[target++] = bytes[index];
      index += run;
      continue;
    }

    const start = index;
    index += run;
    while (index < endOffset && index - start < 128) {
      run = 1;
      while (
        run < 128
        && index + run < endOffset
        && bytes[index + run] === bytes[index]
      ) {
        run += 1;
      }
      if (run >= 3) break;
      index += Math.min(run, 128 - (index - start));
    }
    const length = index - start;
    output[target++] = length - 1;
    output.set(bytes.subarray(start, index), target);
    target += length;
  }
  return target;
}

function dpiRational(value: number): [number, number] {
  const text = value.toString().toLowerCase();
  const [mantissa, exponentText] = text.split("e");
  const exponent = exponentText ? Number(exponentText) : 0;
  const signless = mantissa.replace("-", "");
  const decimal = signless.indexOf(".");
  const fractionalDigits = decimal < 0 ? 0 : signless.length - decimal - 1;
  const digits = BigInt(signless.replace(".", ""));
  const scale = fractionalDigits - exponent;
  let numerator = scale < 0 ? digits * (10n ** BigInt(-scale)) : digits;
  let denominator = scale > 0 ? 10n ** BigInt(scale) : 1n;
  const divisor = greatestCommonDivisor(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  if (numerator > BigInt(UINT32_MAX) || denominator > BigInt(UINT32_MAX)) {
    return approximateRational(value);
  }
  return [Number(numerator), Number(denominator)];
}

function approximateRational(value: number): [number, number] {
  const denominator = 1_000_000;
  const numerator = Math.round(value * denominator);
  if (numerator === 0) throw new Error("TIFF DPI is outside the supported range");
  const divisor = Number(greatestCommonDivisor(BigInt(numerator), BigInt(denominator)));
  const reducedNumerator = numerator / divisor;
  const reducedDenominator = denominator / divisor;
  if (reducedNumerator > UINT32_MAX) throw new Error("TIFF DPI is outside the supported range");
  return [reducedNumerator, reducedDenominator];
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1n;
}

function partsBlob(parts: readonly Uint8Array[], type: string): Blob {
  return new Blob(parts.map(arrayBufferPart), { type });
}

function bytesBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([arrayBufferPart(bytes)], { type });
}

function arrayBufferPart(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function alignEven(value: number): number {
  return value + (value & 1);
}

function alignFour(value: number): number {
  return value + ((4 - value % 4) % 4);
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
