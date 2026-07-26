import type {
  AtomSelection,
  CellOffset,
  FrameData,
  FrameKey,
  Manifest,
  ScenePresentation,
  SourceManifest,
  SourceSegmentManifest,
} from "./types";

export const FIGURE_RECIPE_SCHEMA = "pqviewer.figure";
export const FIGURE_RECIPE_VERSION = 1;
const FIGURE_FINGERPRINT_ARRAYS = new Set([
  "positions",
  "cell",
  "forces",
  "velocities",
  "charges",
]);
const FIGURE_UNWRAPPED_FINGERPRINT_ARRAYS = [
  "unwrapped_positions",
  "unwrapped_image_shifts",
];

export type FigureCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface FigureSource {
  kind: string;
  path: string;
  slice: {
    start: number | null;
    stop: number | null;
    step: number | null;
  };
  segments: SourceSegmentManifest[];
}

export interface FigureCamera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  zoom: number;
  near: number;
  far: number;
}

export type FigureBackground =
  | { kind: "transparent" }
  | { kind: "solid"; color: string };

export interface FigureOutput {
  format: "png" | "tiff";
  width: number;
  height: number;
  dpi: number;
  background: FigureBackground;
  projection: "orthographic" | "perspective";
  fit: boolean;
  padding: number;
  periodicContext: boolean;
}

export type FigureAnnotation =
  | {
    kind: "atom-label";
    atom: AtomSelection;
    text?: string;
    offset?: [number, number];
  }
  | {
    kind: "legend";
    content: "elements" | "residues" | "forces" | "velocities";
    position: FigureCorner;
  }
  | {
    kind: "scale-bar";
    length: number;
    unit: "angstrom" | "nanometer";
    position: FigureCorner;
  };

export interface FigureRecipe {
  schema: typeof FIGURE_RECIPE_SCHEMA;
  schema_version: typeof FIGURE_RECIPE_VERSION;
  source: FigureSource;
  frame: {
    index: number;
    key: FrameKey;
    fingerprint: string;
  };
  scene: {
    presentation: ScenePresentation;
    selection: {
      atoms: AtomSelection[];
      intent: "measurement" | "set";
      minimumImage: boolean;
    };
    vectors: {
      forceScale: number;
      velocityScale: number;
    };
  };
  camera: FigureCamera;
  output: FigureOutput;
  annotations: FigureAnnotation[];
}

export function parseFigureRecipe(value: unknown): FigureRecipe {
  const root = strictObject(value, "Figure recipe", [
    "schema",
    "schema_version",
    "source",
    "frame",
    "scene",
    "camera",
    "output",
    "annotations",
  ]);
  if (root.schema !== FIGURE_RECIPE_SCHEMA) {
    throw new Error(`Figure recipe schema must be ${FIGURE_RECIPE_SCHEMA}`);
  }
  if (root.schema_version !== FIGURE_RECIPE_VERSION) {
    throw new Error(`Unsupported figure recipe version: ${String(root.schema_version)}`);
  }

  const source = parseFigureSource(root.source);
  const frame = parseFrame(root.frame);
  validateFrameReference(source, frame);
  return {
    schema: FIGURE_RECIPE_SCHEMA,
    schema_version: FIGURE_RECIPE_VERSION,
    source,
    frame,
    scene: parseScene(root.scene),
    camera: parseCamera(root.camera),
    output: parseOutput(root.output),
    annotations: array(root.annotations, "Figure recipe annotations").map(
      (annotation, index) => parseAnnotation(annotation, index),
    ),
  };
}

export function parseFigureRecipeJson(value: string): FigureRecipe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Figure recipe is not valid JSON");
  }
  return parseFigureRecipe(parsed);
}

export function cloneFigureRecipe(recipe: FigureRecipe): FigureRecipe {
  return parseFigureRecipe(recipe);
}

export function stringifyFigureRecipe(recipe: FigureRecipe): string {
  return `${JSON.stringify(cloneFigureRecipe(recipe), null, 2)}\n`;
}

export function figureSourceFromManifest(manifest: Manifest): FigureSource {
  if (!manifest.source) throw new Error("The dataset has no source information");
  return parseFigureSource(manifest.source);
}

export function figureSourceIdentity(source: FigureSource | SourceManifest): string {
  const parsed = parseFigureSource(source);
  return JSON.stringify({
    kind: parsed.kind,
    path: parsed.path,
    slice: parsed.slice,
    segments: parsed.segments.map((segment) => ({
      kind: segment.kind,
      path: segment.path,
      input: segment.input,
      files: segment.files,
    })),
  });
}

export function figureFrameFingerprint(
  manifest: Manifest,
  frame: FrameData,
): string {
  const hash = new FigureFingerprint();
  const arrayNames = new Set(FIGURE_FINGERPRINT_ARRAYS);
  if (frame.header.coordinates === "unwrapped") {
    FIGURE_UNWRAPPED_FINGERPRINT_ARRAYS.forEach((name) => arrayNames.add(name));
  }
  const descriptors = frame.header.arrays.filter((descriptor) => (
    arrayNames.has(descriptor.name.toLowerCase())
  ));
  hash.value(manifest.topology);
  hash.value({
    arrays: descriptors,
    pbc: frame.header.pbc ?? null,
  });
  for (const [name, array] of [...frame.arrays.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const normalizedName = name.toLowerCase();
    if (!arrayNames.has(normalizedName)) continue;
    hash.value(normalizedName);
    hash.value(array.constructor.name);
    hash.bytes(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  return `frame-v1:${hash.digest()}`;
}

export function sameFigureSource(
  left: FigureSource | SourceManifest,
  right: FigureSource | SourceManifest,
): boolean {
  try {
    return figureSourceIdentity(left) === figureSourceIdentity(right);
  } catch {
    return false;
  }
}

export function recipeMatchesManifestSource(recipe: FigureRecipe, manifest: Manifest): boolean {
  return Boolean(manifest.source && sameFigureSource(recipe.source, manifest.source));
}

export function sameFrameKey(left: FrameKey | null | undefined, right: FrameKey | null | undefined): boolean {
  if (!left || !right) return false;
  try {
    const first = parseFrameKey(left, "First frame key");
    const second = parseFrameKey(right, "Second frame key");
    return first.source_id === second.source_id
      && first.source_index === second.source_index
      && first.segment_index === second.segment_index
      && first.step === second.step
      && first.time === second.time
      && first.time_unit === second.time_unit;
  } catch {
    return false;
  }
}

function parseFigureSource(value: unknown): FigureSource {
  const source = strictObject(value, "Figure source", ["kind", "path", "slice", "segments"]);
  const kind = nonEmptyString(source.kind, "Figure source kind");
  const path = sourcePath(source.path, "Figure source path");
  const slice = source.slice === undefined
    ? { start: null, stop: null, step: null }
    : parseSlice(source.slice);
  const segments = source.segments === undefined
    ? []
    : array(source.segments, "Figure source segments").map(
      (segment, index) => parseSourceSegment(segment, index),
    );
  if (segments.length === 0) throw new Error("Figure source must include at least one segment");
  return { kind, path, slice, segments };
}

function parseSlice(value: unknown): FigureSource["slice"] {
  const slice = strictObject(value, "Figure source slice", ["start", "stop", "step"]);
  const start = nullableInteger(slice.start, "Figure source slice start");
  const stop = nullableInteger(slice.stop, "Figure source slice stop");
  const step = nullableInteger(slice.step, "Figure source slice step");
  if (step === 0) throw new Error("Figure source slice step cannot be zero");
  return { start, stop, step };
}

function parseSourceSegment(value: unknown, index: number): SourceSegmentManifest {
  const label = `Figure source segment ${index + 1}`;
  const segment = strictObject(value, label, [
    "source_id",
    "kind",
    "path",
    "input",
    "frame_count",
    "files",
  ]);
  const path = nullableSourcePath(segment.path, `${label} path`);
  const input = nullableSourcePath(segment.input, `${label} input`);
  const files = segment.files === undefined
    ? {}
    : parseSourceFiles(segment.files, `${label} files`);
  if (path === null && input === null && Object.keys(files).length === 0) {
    throw new Error(`${label} has no durable source`);
  }
  return {
    source_id: sourceIdentifier(segment.source_id, `${label} source_id`),
    kind: nonEmptyString(segment.kind, `${label} kind`),
    path,
    input,
    frame_count: nonNegativeInteger(segment.frame_count, `${label} frame_count`),
    files,
  };
}

function parseSourceFiles(value: unknown, label: string): Record<string, string> {
  const files = strictRecord(value, label);
  const result: Record<string, string> = {};
  for (const key of Object.keys(files).sort()) {
    if (!key.trim() || forbiddenRecordKey(key)) throw new Error(`${label} contains an invalid role`);
    result[key] = sourcePath(files[key], `${label}.${key}`);
  }
  return result;
}

function parseFrame(value: unknown): FigureRecipe["frame"] {
  const frame = strictObject(value, "Figure frame", [
    "index",
    "key",
    "fingerprint",
  ]);
  const fingerprint = nonEmptyString(
    frame.fingerprint,
    "Figure frame fingerprint",
  );
  if (!/^frame-v1:[0-9a-f]{16}$/.test(fingerprint)) {
    throw new Error("Figure frame fingerprint is invalid");
  }
  return {
    index: nonNegativeInteger(frame.index, "Figure frame index"),
    key: parseFrameKey(frame.key, "Figure frame key"),
    fingerprint,
  };
}

function validateFrameReference(source: FigureSource, frame: FigureRecipe["frame"]): void {
  const segment = source.segments[frame.key.segment_index];
  if (!segment) throw new Error("Figure frame segment is outside the source");
  if (sourceIdentifier(segment.source_id, "Figure source segment source_id") !== frame.key.source_id) {
    throw new Error("Figure frame source_id does not match its segment");
  }
  if (frame.key.source_index >= segment.frame_count) {
    throw new Error("Figure frame source_index is outside its segment");
  }

  const frameCounts = source.segments.map((entry) => entry.frame_count);
  const sliced = normalizedSlice(frameCounts.reduce((total, count) => total + count, 0), source.slice);
  if (frame.index >= sliced.count) throw new Error("Figure frame index is outside the source slice");
  const physicalIndex = sliced.start + frame.index * sliced.step;
  let offset = 0;
  let expectedSegment = -1;
  let expectedSourceIndex = -1;
  for (let index = 0; index < frameCounts.length; index += 1) {
    const end = offset + frameCounts[index];
    if (physicalIndex >= offset && physicalIndex < end) {
      expectedSegment = index;
      expectedSourceIndex = physicalIndex - offset;
      break;
    }
    offset = end;
  }
  if (
    expectedSegment !== frame.key.segment_index
    || expectedSourceIndex !== frame.key.source_index
  ) {
    throw new Error("Figure frame key does not match the sliced frame index");
  }
}

function parseFrameKey(value: unknown, label: string): FrameKey {
  const key = strictObject(value, label, [
    "source_id",
    "source_index",
    "segment_index",
    "step",
    "time",
    "time_unit",
  ]);
  return {
    source_id: sourceIdentifier(key.source_id, `${label} source_id`),
    source_index: nonNegativeInteger(key.source_index, `${label} source_index`),
    segment_index: nonNegativeInteger(key.segment_index, `${label} segment_index`),
    step: nullableInteger(key.step, `${label} step`),
    time: nullableNumber(key.time, `${label} time`),
    time_unit: nullableString(key.time_unit, `${label} time_unit`),
  };
}

function parseScene(value: unknown): FigureRecipe["scene"] {
  const scene = strictObject(value, "Figure scene", ["presentation", "selection", "vectors"]);
  const selection = strictObject(scene.selection, "Figure selection", [
    "atoms",
    "intent",
    "minimumImage",
  ]);
  const vectors = strictObject(scene.vectors, "Figure vectors", ["forceScale", "velocityScale"]);
  const atoms = array(selection.atoms, "Figure selection atoms").map(
    (atom, index) => parseAtomSelection(atom, `Figure selection atom ${index + 1}`),
  );
  const identities = new Set<string>();
  for (const atom of atoms) {
    const identity = `${atom.atom}:${atom.image.join(",")}`;
    if (identities.has(identity)) throw new Error("Figure selection contains duplicate atoms");
    identities.add(identity);
  }
  return {
    presentation: parsePresentation(scene.presentation),
    selection: {
      atoms,
      intent: enumeration(selection.intent, ["measurement", "set"], "Figure selection intent"),
      minimumImage: boolean(selection.minimumImage, "Figure selection minimumImage"),
    },
    vectors: {
      forceScale: positiveNumber(vectors.forceScale, "Figure force scale"),
      velocityScale: positiveNumber(vectors.velocityScale, "Figure velocity scale"),
    },
  };
}

function parsePresentation(value: unknown): ScenePresentation {
  const presentation = strictObject(value, "Figure presentation", [
    "mode",
    "water",
    "hydrogens",
    "wrap",
    "cellOrigin",
    "mirror",
    "images",
    "cell",
    "forces",
    "velocities",
    "atomScale",
    "bondScale",
    "color",
    "quality",
  ]);
  const images = strictObject(presentation.images, "Figure presentation images", ["min", "max"]);
  const minimumImages = integerTriple(images.min, "Figure presentation minimum image");
  const maximumImages = integerTriple(images.max, "Figure presentation maximum image");
  minimumImages.forEach((minimum, axis) => {
    if (minimum > maximumImages[axis]) {
      throw new Error("Figure presentation image minimum cannot exceed its maximum");
    }
  });
  return {
    mode: enumeration(
      presentation.mode,
      ["ball-stick", "spacefill", "licorice", "lines", "ribbon"],
      "Figure presentation mode",
    ),
    water: enumeration(presentation.water, ["show", "hide", "only"], "Figure presentation water"),
    hydrogens: boolean(presentation.hydrogens, "Figure presentation hydrogens"),
    wrap: enumeration(
      presentation.wrap,
      ["atom", "molecule", "unwrapped", "none"],
      "Figure presentation wrap",
    ),
    cellOrigin: numberTriple(presentation.cellOrigin, "Figure presentation cellOrigin"),
    mirror: booleanTriple(presentation.mirror, "Figure presentation mirror"),
    images: {
      min: minimumImages,
      max: maximumImages,
    },
    cell: boolean(presentation.cell, "Figure presentation cell"),
    forces: boolean(presentation.forces, "Figure presentation forces"),
    velocities: boolean(presentation.velocities, "Figure presentation velocities"),
    atomScale: positiveNumber(presentation.atomScale, "Figure presentation atomScale"),
    bondScale: positiveNumber(presentation.bondScale, "Figure presentation bondScale"),
    color: enumeration(presentation.color, ["element", "residue", "chain"], "Figure presentation color"),
    quality: enumeration(presentation.quality, ["auto", "high"], "Figure presentation quality"),
  };
}

function parseAtomSelection(value: unknown, label: string): AtomSelection {
  const selection = strictObject(value, label, ["atom", "image"]);
  return {
    atom: nonNegativeInteger(selection.atom, `${label} atom`),
    image: integerTriple(selection.image, `${label} image`),
  };
}

function parseCamera(value: unknown): FigureCamera {
  const camera = strictObject(value, "Figure camera", [
    "position",
    "target",
    "up",
    "fov",
    "zoom",
    "near",
    "far",
  ]);
  const position = numberTriple(camera.position, "Figure camera position");
  const target = numberTriple(camera.target, "Figure camera target");
  const up = numberTriple(camera.up, "Figure camera up");
  const fov = finiteNumber(camera.fov, "Figure camera fov");
  const zoom = positiveNumber(camera.zoom, "Figure camera zoom");
  const near = positiveNumber(camera.near, "Figure camera near");
  const far = positiveNumber(camera.far, "Figure camera far");
  if (fov <= 0 || fov >= 180) throw new Error("Figure camera fov must be between 0 and 180");
  if (far <= near) throw new Error("Figure camera far must be greater than near");
  if (squaredDistance(position, target) <= Number.EPSILON) {
    throw new Error("Figure camera position must differ from target");
  }
  if (up[0] ** 2 + up[1] ** 2 + up[2] ** 2 <= Number.EPSILON) {
    throw new Error("Figure camera up cannot be zero");
  }
  const view = [
    target[0] - position[0],
    target[1] - position[1],
    target[2] - position[2],
  ] as const;
  const cross = [
    view[1] * up[2] - view[2] * up[1],
    view[2] * up[0] - view[0] * up[2],
    view[0] * up[1] - view[1] * up[0],
  ];
  if (cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2 <= Number.EPSILON) {
    throw new Error("Figure camera up cannot be parallel to its view");
  }
  return { position, target, up, fov, zoom, near, far };
}

function parseOutput(value: unknown): FigureOutput {
  const output = strictObject(value, "Figure output", [
    "format",
    "width",
    "height",
    "dpi",
    "background",
    "projection",
    "fit",
    "padding",
    "periodicContext",
  ]);
  const width = positiveInteger(output.width, "Figure output width");
  const height = positiveInteger(output.height, "Figure output height");
  if (!Number.isSafeInteger(width * height)) throw new Error("Figure output dimensions are too large");
  const padding = finiteNumber(output.padding, "Figure output padding");
  if (padding < 0 || padding > 0.4) throw new Error("Figure output padding must be between 0 and 0.4");
  return {
    format: enumeration(output.format, ["png", "tiff"], "Figure output format"),
    width,
    height,
    dpi: positiveNumber(output.dpi, "Figure output dpi"),
    background: parseBackground(output.background),
    projection: enumeration(
      output.projection,
      ["orthographic", "perspective"],
      "Figure output projection",
    ),
    fit: boolean(output.fit, "Figure output fit"),
    padding,
    periodicContext: boolean(output.periodicContext, "Figure output periodicContext"),
  };
}

function parseBackground(value: unknown): FigureBackground {
  const background = record(value, "Figure output background");
  if (background.kind === "transparent") {
    rejectUnknownKeys(background, "Figure output background", ["kind"]);
    return { kind: "transparent" };
  }
  if (background.kind === "solid") {
    rejectUnknownKeys(background, "Figure output background", ["kind", "color"]);
    const color = nonEmptyString(background.color, "Figure output background color").toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color)) {
      throw new Error("Figure output background color must use #RRGGBB");
    }
    return { kind: "solid", color };
  }
  throw new Error("Figure output background kind must be transparent or solid");
}

function parseAnnotation(value: unknown, index: number): FigureAnnotation {
  const label = `Figure annotation ${index + 1}`;
  const annotation = record(value, label);
  if (annotation.kind === "atom-label") {
    rejectUnknownKeys(annotation, label, ["kind", "atom", "text", "offset"]);
    const result: Extract<FigureAnnotation, { kind: "atom-label" }> = {
      kind: "atom-label",
      atom: parseAtomSelection(annotation.atom, `${label} atom`),
    };
    if (annotation.text !== undefined) {
      result.text = nonEmptyString(annotation.text, `${label} text`);
    }
    if (annotation.offset !== undefined) {
      result.offset = numberPair(annotation.offset, `${label} offset`);
    }
    return result;
  }
  if (annotation.kind === "legend") {
    rejectUnknownKeys(annotation, label, ["kind", "content", "position"]);
    return {
      kind: "legend",
      content: enumeration(
        annotation.content,
        ["elements", "residues", "forces", "velocities"],
        `${label} content`,
      ),
      position: corner(annotation.position, `${label} position`),
    };
  }
  if (annotation.kind === "scale-bar") {
    rejectUnknownKeys(annotation, label, ["kind", "length", "unit", "position"]);
    return {
      kind: "scale-bar",
      length: positiveNumber(annotation.length, `${label} length`),
      unit: enumeration(annotation.unit, ["angstrom", "nanometer"], `${label} unit`),
      position: corner(annotation.position, `${label} position`),
    };
  }
  throw new Error(`${label} kind is unsupported`);
}

function corner(value: unknown, label: string): FigureCorner {
  return enumeration(value, ["top-left", "top-right", "bottom-left", "bottom-right"], label);
}

function strictObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const result = record(value, label);
  rejectUnknownKeys(result, label, keys);
  return result;
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  return record(value, label);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field: ${unknown[0]}`);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function enumeration<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} is invalid`);
  }
  return value as T;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return nonEmptyString(value, label);
}

function sourceIdentifier(value: unknown, label: string): string {
  return nonEmptyString(value, label);
}

function sourcePath(value: unknown, label: string): string {
  return nonEmptyString(value, label);
}

function nullableSourcePath(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return sourcePath(value, label);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function positiveNumber(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result <= 0) throw new Error(`${label} must be positive`);
  return result;
}

function integer(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} must be an integer`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result <= 0) throw new Error(`${label} must be positive`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result < 0) throw new Error(`${label} cannot be negative`);
  return result;
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  return integer(value, label);
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  return finiteNumber(value, label);
}

function numberPair(value: unknown, label: string): [number, number] {
  const values = tuple(value, 2, label);
  return [
    finiteNumber(values[0], `${label}[0]`),
    finiteNumber(values[1], `${label}[1]`),
  ];
}

function numberTriple(value: unknown, label: string): [number, number, number] {
  const values = tuple(value, 3, label);
  return [
    finiteNumber(values[0], `${label}[0]`),
    finiteNumber(values[1], `${label}[1]`),
    finiteNumber(values[2], `${label}[2]`),
  ];
}

function integerTriple(value: unknown, label: string): CellOffset {
  const values = tuple(value, 3, label);
  return [
    integer(values[0], `${label}[0]`),
    integer(values[1], `${label}[1]`),
    integer(values[2], `${label}[2]`),
  ];
}

function booleanTriple(value: unknown, label: string): [boolean, boolean, boolean] {
  const values = tuple(value, 3, label);
  return [
    boolean(values[0], `${label}[0]`),
    boolean(values[1], `${label}[1]`),
    boolean(values[2], `${label}[2]`),
  ];
}

function tuple(value: unknown, length: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`${label} must contain ${length} values`);
  }
  return value;
}

function squaredDistance(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return (left[0] - right[0]) ** 2
    + (left[1] - right[1]) ** 2
    + (left[2] - right[2]) ** 2;
}

function normalizedSlice(
  length: number,
  slice: FigureSource["slice"],
): { start: number; step: number; count: number } {
  const step = slice.step ?? 1;
  if (step > 0) {
    const start = positiveSliceIndex(slice.start, length, 0);
    const stop = positiveSliceIndex(slice.stop, length, length);
    return {
      start,
      step,
      count: start >= stop ? 0 : Math.floor((stop - start - 1) / step) + 1,
    };
  }
  const start = negativeSliceIndex(slice.start, length, length - 1);
  const stop = negativeSliceIndex(slice.stop, length, -1);
  return {
    start,
    step,
    count: start <= stop ? 0 : Math.floor((start - stop - 1) / -step) + 1,
  };
}

function positiveSliceIndex(value: number | null, length: number, fallback: number): number {
  if (value === null) return fallback;
  const resolved = value < 0 ? value + length : value;
  return Math.max(0, Math.min(length, resolved));
}

function negativeSliceIndex(value: number | null, length: number, fallback: number): number {
  if (value === null) return fallback;
  const resolved = value < 0 ? value + length : value;
  return Math.max(-1, Math.min(length - 1, resolved));
}

class FigureFingerprint {
  private first = 0x811c9dc5;
  private second = 0x9e3779b9;
  private readonly numberBuffer = new ArrayBuffer(8);
  private readonly numberView = new DataView(this.numberBuffer);
  private readonly encoder = new TextEncoder();

  bytes(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.first = Math.imul(this.first ^ byte, 0x01000193);
      this.second = Math.imul(this.second ^ byte, 0x85ebca6b);
      this.second ^= this.second >>> 13;
    }
  }

  value(value: unknown): void {
    if (value === null || value === undefined) {
      this.text("null");
      return;
    }
    if (typeof value === "string") {
      this.text(`s${value.length}:`);
      this.text(value);
      return;
    }
    if (typeof value === "number") {
      this.text("n");
      this.numberView.setFloat64(0, value, true);
      this.bytes(new Uint8Array(this.numberBuffer));
      return;
    }
    if (typeof value === "boolean") {
      this.text(value ? "true" : "false");
      return;
    }
    if (Array.isArray(value)) {
      this.text("[");
      for (const item of value) this.value(item);
      this.text("]");
      return;
    }
    if (typeof value === "object") {
      this.text("{");
      for (const key of Object.keys(value).sort()) {
        this.value(key);
        this.value((value as Record<string, unknown>)[key]);
      }
      this.text("}");
      return;
    }
    this.text(typeof value);
  }

  digest(): string {
    return [this.first, this.second]
      .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
      .join("");
  }

  private text(value: string): void {
    this.bytes(this.encoder.encode(value));
  }
}

function forbiddenRecordKey(value: string): boolean {
  return value === "__proto__" || value === "prototype" || value === "constructor";
}
