import * as THREE from "three";
import type { CellOffset } from "../types";

export type ProteinSecondaryStructure = "coil" | "helix" | "sheet";

export interface ProteinCartoonResidue {
  atomIndex: number;
  residueIndex: number;
  image?: CellOffset;
  n: THREE.Vector3;
  ca: THREE.Vector3;
  c: THREE.Vector3;
  o: THREE.Vector3;
}

export interface ProteinCartoonOptions {
  scale: number;
  quality: "auto" | "high";
  translations?: readonly THREE.Vector3[];
  translationImages?: readonly CellOffset[];
  structures?: readonly ProteinSecondaryStructure[];
}

export interface CartoonCrossSection {
  width: number;
  depth: number;
  squareness: number;
}

export interface ProteinCartoonCameraPoint {
  center: THREE.Vector3;
  faceNormal: THREE.Vector3 | null;
}

interface CartoonSample {
  center: THREE.Vector3;
  side: THREE.Vector3;
  normal: THREE.Vector3;
  atomIndex: number;
  image: CellOffset;
  progress: number;
  structure: ProteinSecondaryStructure;
  structureWeights: [number, number, number];
  width: number;
  depth: number;
  squareness: number;
}

const STRUCTURE_CODE: Record<ProteinSecondaryStructure, number> = {
  coil: 0,
  helix: 1,
  sheet: 2,
};

export function classifyBackboneAngles(
  phi: number,
  psi: number,
): ProteinSecondaryStructure {
  if (phi >= -120 && phi <= -30 && psi >= -100 && psi <= 45) return "helix";
  if (
    phi >= -180
    && phi <= -60
    && ((psi >= 60 && psi <= 180) || (psi >= -180 && psi <= -130))
  ) {
    return "sheet";
  }
  return "coil";
}

export function inferProteinSecondaryStructure(
  residues: readonly ProteinCartoonResidue[],
): ProteinSecondaryStructure[] {
  const result = Array<ProteinSecondaryStructure>(residues.length).fill("coil");
  for (let index = 1; index < residues.length - 1; index += 1) {
    const previous = residues[index - 1];
    const residue = residues[index];
    const next = residues[index + 1];
    result[index] = classifyBackboneAngles(
      backboneDihedralDegrees(previous.c, residue.n, residue.ca, residue.c),
      backboneDihedralDegrees(residue.n, residue.ca, residue.c, next.n),
    );
  }

  for (let index = 1; index < result.length - 1; index += 1) {
    if (
      result[index] === "coil"
      && result[index - 1] === result[index + 1]
      && result[index - 1] !== "coil"
    ) {
      result[index] = result[index - 1];
    }
  }

  if (result.length >= 2 && result[0] === "coil" && result[1] === "sheet") result[0] = "sheet";
  const last = result.length - 1;
  if (last >= 1 && result[last] === "coil" && result[last - 1] === "sheet") result[last] = "sheet";
  filterShortRuns(result, "helix", 4);
  filterShortRuns(result, "sheet", 4);
  return result;
}

export function proteinCartoonResidueCenters(
  residues: readonly ProteinCartoonResidue[],
  structures?: readonly ProteinSecondaryStructure[],
): THREE.Vector3[] {
  const resolvedStructures = structures?.length === residues.length
    ? structures
    : inferProteinSecondaryStructure(residues);
  return cartoonCenters(residues, resolvedStructures);
}

export function proteinCartoonCameraTrace(
  residues: readonly ProteinCartoonResidue[],
  structures?: readonly ProteinSecondaryStructure[],
): ProteinCartoonCameraPoint[] {
  if (residues.length < 3) return [];
  const resolvedStructures = structures?.length === residues.length
    ? structures
    : inferProteinSecondaryStructure(residues);
  return cartoonSamples(residues, resolvedStructures, 1, 1).map((sample) => ({
    center: sample.center.clone(),
    faceNormal: sample.structure === "coil" ? null : sample.normal.clone(),
  }));
}

export function cartoonCrossSection(
  structure: ProteinSecondaryStructure,
  scale = 1,
): CartoonCrossSection {
  const safeScale = Number.isFinite(scale) ? Math.max(0.2, scale) : 1;
  if (structure === "helix") {
    return {
      width: 0.38 * safeScale,
      depth: 0.23 * safeScale,
      squareness: 0.2,
    };
  }
  if (structure === "sheet") {
    return {
      width: 0.39 * safeScale,
      depth: 0.115 * safeScale,
      squareness: 0.55,
    };
  }
  return {
    width: 0.135 * safeScale,
    depth: 0.135 * safeScale,
    squareness: 0,
  };
}

export function buildProteinCartoonGeometry(
  residues: readonly ProteinCartoonResidue[],
  options: ProteinCartoonOptions,
): THREE.BufferGeometry | null {
  if (residues.length < 3) return null;
  const translations = options.translations?.length
    ? [...options.translations]
    : [new THREE.Vector3()];
  const translationImages = translations.map((_, index): CellOffset => (
    options.translationImages?.[index] ?? [0, 0, 0]
  ));
  const structures = options.structures?.length === residues.length
    ? [...options.structures]
    : inferProteinSecondaryStructure(residues);
  const highDetail = options.quality === "high";
  const repeatedResidues = residues.length * translations.length;
  const radialSegments = repeatedResidues > 20_000 ? 8 : highDetail ? 16 : 12;
  const vertexBudget = highDetail ? 200_000 : 90_000;
  const maxSubdivisions = highDetail ? 10 : 6;
  const subdivisions = THREE.MathUtils.clamp(
    Math.floor(vertexBudget / Math.max(1, (residues.length - 1) * radialSegments * translations.length)),
    1,
    maxSubdivisions,
  );
  const samples = cartoonSamples(residues, structures, options.scale, subdivisions);
  const sampleCount = samples.length;
  const verticesPerImage = sampleCount * radialSegments + 2;
  const vertexCount = verticesPerImage * translations.length;
  const sideIndexCount = (sampleCount - 1) * radialSegments * 6;
  const capIndexCount = radialSegments * 6;
  const indexCount = (sideIndexCount + capIndexCount) * translations.length;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  colors.fill(1);
  const atomIndices = new Float32Array(vertexCount);
  const imageOffsets = new Float32Array(vertexCount * 3);
  const progress = new Float32Array(vertexCount);
  const secondaryStructure = new Float32Array(vertexCount);
  const secondaryStructureWeights = new Float32Array(vertexCount * 3);
  const indices = vertexCount > 65_535
    ? new Uint32Array(indexCount)
    : new Uint16Array(indexCount);
  let vertexCursor = 0;
  let indexCursor = 0;
  const point = new THREE.Vector3();

  for (let imageIndex = 0; imageIndex < translations.length; imageIndex += 1) {
    const translation = translations[imageIndex];
    const translationImage = translationImages[imageIndex];
    const imageStart = vertexCursor;
    for (const sample of samples) {
      for (let segment = 0; segment < radialSegments; segment += 1) {
        const angle = segment / radialSegments * Math.PI * 2;
        const sideFactor = superellipseCoordinate(Math.cos(angle), sample.squareness);
        const normalFactor = superellipseCoordinate(Math.sin(angle), sample.squareness);
        point.copy(sample.center)
          .add(translation)
          .addScaledVector(sample.side, sideFactor * sample.width)
          .addScaledVector(sample.normal, normalFactor * sample.depth)
          .toArray(positions, vertexCursor * 3);
        atomIndices[vertexCursor] = sample.atomIndex;
        writeImageOffset(sample.image, translationImage, imageOffsets, vertexCursor);
        progress[vertexCursor] = sample.progress;
        secondaryStructure[vertexCursor] = STRUCTURE_CODE[sample.structure];
        writeStructureWeights(
          sample.structureWeights,
          secondaryStructureWeights,
          vertexCursor,
        );
        vertexCursor += 1;
      }
    }

    const startCap = vertexCursor;
    writeCapVertex(
      samples[0],
      translation,
      translationImage,
      positions,
      atomIndices,
      imageOffsets,
      progress,
      secondaryStructure,
      secondaryStructureWeights,
      vertexCursor,
    );
    vertexCursor += 1;
    const endCap = vertexCursor;
    writeCapVertex(
      samples[sampleCount - 1],
      translation,
      translationImage,
      positions,
      atomIndices,
      imageOffsets,
      progress,
      secondaryStructure,
      secondaryStructureWeights,
      vertexCursor,
    );
    vertexCursor += 1;

    for (let sample = 1; sample < sampleCount; sample += 1) {
      const previousRing = imageStart + (sample - 1) * radialSegments;
      const ring = imageStart + sample * radialSegments;
      for (let segment = 0; segment < radialSegments; segment += 1) {
        const next = (segment + 1) % radialSegments;
        indices[indexCursor++] = previousRing + segment;
        indices[indexCursor++] = previousRing + next;
        indices[indexCursor++] = ring + segment;
        indices[indexCursor++] = ring + segment;
        indices[indexCursor++] = previousRing + next;
        indices[indexCursor++] = ring + next;
      }
    }

    const endRing = imageStart + (sampleCount - 1) * radialSegments;
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const next = (segment + 1) % radialSegments;
      indices[indexCursor++] = startCap;
      indices[indexCursor++] = imageStart + next;
      indices[indexCursor++] = imageStart + segment;
      indices[indexCursor++] = endCap;
      indices[indexCursor++] = endRing + segment;
      indices[indexCursor++] = endRing + next;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("atomIndex", new THREE.BufferAttribute(atomIndices, 1));
  geometry.setAttribute("imageOffset", new THREE.BufferAttribute(imageOffsets, 3));
  geometry.setAttribute("sequenceProgress", new THREE.BufferAttribute(progress, 1));
  geometry.setAttribute("secondaryStructure", new THREE.BufferAttribute(secondaryStructure, 1));
  geometry.setAttribute(
    "secondaryStructureWeights",
    new THREE.BufferAttribute(secondaryStructureWeights, 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function cartoonSamples(
  residues: readonly ProteinCartoonResidue[],
  structures: readonly ProteinSecondaryStructure[],
  scale: number,
  subdivisions: number,
): CartoonSample[] {
  const centers = cartoonCenters(residues, structures);
  const curve = new THREE.CatmullRomCurve3(centers, false, "centripetal");
  const residueSides = stableResidueSides(residues);
  const sheetRuns = structureRuns(structures, "sheet");
  const segmentCount = residues.length - 1;
  const sampleCount = segmentCount * subdivisions + 1;
  const samples: CartoonSample[] = [];
  let previousSide: THREE.Vector3 | null = null;
  let previousTangent: THREE.Vector3 | null = null;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const progress = sampleIndex / (sampleCount - 1);
    const residuePosition = progress * segmentCount;
    const lower = Math.min(Math.floor(residuePosition), residues.length - 1);
    const upper = Math.min(lower + 1, residues.length - 1);
    const mix = smoothstep(residuePosition - lower);
    const tangent = curve.getTangent(progress).normalize();
    const targetSide = residueSides[lower].clone().lerp(residueSides[upper], mix);
    targetSide.addScaledVector(tangent, -targetSide.dot(tangent));
    if (targetSide.lengthSq() < 1e-8) targetSide.copy(perpendicularTo(tangent));
    targetSide.normalize();
    const nearestStructure = structures[Math.min(Math.round(residuePosition), structures.length - 1)];
    const trackingPerResidue = nearestStructure === "sheet"
      ? 0.45
      : nearestStructure === "helix" ? 0.04 : 0.1;
    const tracking = 1 - Math.pow(
      1 - trackingPerResidue,
      1 / Math.max(1, subdivisions),
    );
    const side: THREE.Vector3 = previousSide && previousTangent
      ? transportedSide(
          previousSide,
          previousTangent,
          tangent,
          targetSide,
          tracking,
        )
      : targetSide;
    previousSide = side.clone();
    previousTangent = tangent.clone();
    const normal = new THREE.Vector3().crossVectors(tangent, side).normalize();
    const lowerSection = cartoonCrossSection(structures[lower], scale);
    const upperSection = cartoonCrossSection(structures[upper], scale);
    const arrow = sheetArrowSection(residuePosition, sheetRuns, structures, scale);
    samples.push({
      center: curve.getPoint(progress),
      side,
      normal,
      atomIndex: residues[Math.min(Math.round(residuePosition), residues.length - 1)].atomIndex,
      image: residues[Math.min(Math.round(residuePosition), residues.length - 1)].image ?? [0, 0, 0],
      progress,
      structure: nearestStructure,
      structureWeights: blendedStructureWeights(
        structures[lower],
        structures[upper],
        mix,
      ),
      width: arrow?.width ?? THREE.MathUtils.lerp(lowerSection.width, upperSection.width, mix),
      depth: arrow?.depth ?? THREE.MathUtils.lerp(lowerSection.depth, upperSection.depth, mix),
      squareness: arrow?.squareness ?? THREE.MathUtils.lerp(
        lowerSection.squareness,
        upperSection.squareness,
        mix,
      ),
    });
  }
  return samples;
}

function cartoonCenters(
  residues: readonly ProteinCartoonResidue[],
  structures: readonly ProteinSecondaryStructure[],
): THREE.Vector3[] {
  const centers = residues.map((residue) => residue.ca.clone());
  for (const [start, end] of structureRuns(structures, "helix")) {
    const original = centers.slice(start, end + 1).map((point) => point.clone());
    let smoothed = original;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      smoothed = smoothed.map((_, index) => {
        const point = new THREE.Vector3();
        for (let offset = -2; offset <= 2; offset += 1) {
          point.add(extrapolatedRunPoint(smoothed, index + offset));
        }
        return point.multiplyScalar(0.2);
      });
    }
    for (let index = 0; index < smoothed.length; index += 1) {
      const edgeDistance = Math.min(index, smoothed.length - index - 1);
      const blend = edgeDistance === 0 ? 0.65 : edgeDistance === 1 ? 0.88 : 1;
      centers[start + index].lerp(smoothed[index], blend);
    }
  }
  for (const [start, end] of structureRuns(structures, "sheet")) {
    const expandedStart = Math.max(0, start - 1);
    const expandedEnd = Math.min(residues.length - 1, end + 1);
    let smoothed = residues
      .slice(expandedStart, expandedEnd + 1)
      .map((residue) => residue.ca.clone());
    for (let cycle = 0; cycle < 2; cycle += 1) {
      smoothed = smoothed.map((point, index) => {
        if (index === 0 || index === smoothed.length - 1) return point.clone();
        return smoothed[index - 1].clone()
          .addScaledVector(point, 2)
          .add(smoothed[index + 1])
          .multiplyScalar(0.25);
      });
    }
    for (let index = start; index <= end; index += 1) {
      centers[index].copy(smoothed[index - expandedStart]);
    }
  }
  return centers;
}

function extrapolatedRunPoint(
  points: readonly THREE.Vector3[],
  index: number,
): THREE.Vector3 {
  if (index >= 0 && index < points.length) return points[index];
  if (points.length === 1) return points[0];
  if (index < 0) {
    return points[0].clone().addScaledVector(
      points[0].clone().sub(points[1]),
      -index,
    );
  }
  const last = points.length - 1;
  return points[last].clone().addScaledVector(
    points[last].clone().sub(points[last - 1]),
    index - last,
  );
}

function transportedSide(
  previous: THREE.Vector3,
  previousTangent: THREE.Vector3,
  tangent: THREE.Vector3,
  target: THREE.Vector3,
  tracking: number,
): THREE.Vector3 {
  const side = previous.clone().applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(previousTangent, tangent),
  );
  side.addScaledVector(tangent, -side.dot(tangent));
  if (side.lengthSq() < 1e-8) side.copy(target);
  side.normalize();
  const alignedTarget = target.clone();
  if (side.dot(alignedTarget) < 0) alignedTarget.negate();
  const cross = new THREE.Vector3().crossVectors(side, alignedTarget);
  const angle = Math.atan2(
    tangent.dot(cross),
    THREE.MathUtils.clamp(side.dot(alignedTarget), -1, 1),
  );
  side.applyAxisAngle(tangent, angle * THREE.MathUtils.clamp(tracking, 0, 1));
  side.addScaledVector(tangent, -side.dot(tangent));
  return side.lengthSq() < 1e-8 ? perpendicularTo(tangent) : side.normalize();
}

function blendedStructureWeights(
  lower: ProteinSecondaryStructure,
  upper: ProteinSecondaryStructure,
  mix: number,
): [number, number, number] {
  const weights: [number, number, number] = [0, 0, 0];
  const upperWeight = lower === upper ? 0 : smoothstep(mix);
  weights[STRUCTURE_CODE[lower]] += 1 - upperWeight;
  weights[STRUCTURE_CODE[upper]] += upperWeight;
  return weights;
}

function stableResidueSides(
  residues: readonly ProteinCartoonResidue[],
): THREE.Vector3[] {
  const result: THREE.Vector3[] = [];
  for (let index = 0; index < residues.length; index += 1) {
    const previous = residues[Math.max(0, index - 1)].ca;
    const next = residues[Math.min(residues.length - 1, index + 1)].ca;
    const tangent = next.clone().sub(previous).normalize();
    const side = residues[index].o.clone().sub(residues[index].c);
    side.addScaledVector(tangent, -side.dot(tangent));
    if (side.lengthSq() < 1e-8) {
      side.copy(result[index - 1] ?? perpendicularTo(tangent));
    }
    side.normalize();
    if (result.length > 0 && result[result.length - 1].dot(side) < 0) side.negate();
    result.push(side);
  }
  return result.map((side, index) => {
    const smoothed = side.clone().multiplyScalar(2);
    if (index > 0) smoothed.add(result[index - 1]);
    if (index < result.length - 1) smoothed.add(result[index + 1]);
    return smoothed.normalize();
  });
}

function perpendicularTo(tangent: THREE.Vector3): THREE.Vector3 {
  const axis = Math.abs(tangent.y) < 0.85
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  return new THREE.Vector3().crossVectors(tangent, axis).normalize();
}

function backboneDihedralDegrees(
  first: THREE.Vector3,
  second: THREE.Vector3,
  third: THREE.Vector3,
  fourth: THREE.Vector3,
): number {
  const b0 = first.clone().sub(second);
  const b1 = third.clone().sub(second);
  const b2 = fourth.clone().sub(third);
  if (b1.lengthSq() < 1e-12) return Number.NaN;
  b1.normalize();
  const v = b0.addScaledVector(b1, -b0.dot(b1));
  const w = b2.addScaledVector(b1, -b2.dot(b1));
  if (v.lengthSq() < 1e-12 || w.lengthSq() < 1e-12) return Number.NaN;
  return THREE.MathUtils.radToDeg(Math.atan2(
    new THREE.Vector3().crossVectors(b1, v).dot(w),
    v.dot(w),
  ));
}

function filterShortRuns(
  structures: ProteinSecondaryStructure[],
  type: ProteinSecondaryStructure,
  minimum: number,
): void {
  for (const [start, end] of structureRuns(structures, type)) {
    if (end - start + 1 >= minimum) continue;
    for (let index = start; index <= end; index += 1) structures[index] = "coil";
  }
}

function structureRuns(
  structures: readonly ProteinSecondaryStructure[],
  type: ProteinSecondaryStructure,
): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  let start = -1;
  for (let index = 0; index <= structures.length; index += 1) {
    if (index < structures.length && structures[index] === type) {
      if (start < 0) start = index;
      continue;
    }
    if (start >= 0) result.push([start, index - 1]);
    start = -1;
  }
  return result;
}

function sheetArrowSection(
  position: number,
  runs: readonly [number, number][],
  structures: readonly ProteinSecondaryStructure[],
  scale: number,
): Pick<CartoonSample, "width" | "depth" | "squareness"> | null {
  const sheet = cartoonCrossSection("sheet", scale);
  for (const [start, end] of runs) {
    const terminal = end === structures.length - 1;
    const nextStructure = structures[Math.min(end + 1, structures.length - 1)];
    const nextSection = cartoonCrossSection(nextStructure, scale);
    const arrowStart = Math.max(start, end - 0.9);
    const arrowPeak = terminal ? end - 0.28 : end - 0.2;
    const arrowEnd = terminal ? end : Math.min(structures.length - 1, end + 0.65);
    if (position < arrowStart || position > arrowEnd) continue;
    const headWidth = sheet.width * 1.35;
    if (position <= arrowPeak) {
      const mix = smoothstep((position - arrowStart) / Math.max(0.01, arrowPeak - arrowStart));
      return {
        width: THREE.MathUtils.lerp(sheet.width, headWidth, mix),
        depth: sheet.depth,
        squareness: sheet.squareness,
      };
    }
    const mix = smoothstep((position - arrowPeak) / Math.max(0.01, arrowEnd - arrowPeak));
    const tip = terminal
      ? {
          width: 0.035 * Math.max(0.2, scale),
          depth: 0.035 * Math.max(0.2, scale),
          squareness: 0,
        }
      : nextSection;
    return {
      width: THREE.MathUtils.lerp(headWidth, tip.width, mix),
      depth: THREE.MathUtils.lerp(sheet.depth, tip.depth, mix),
      squareness: THREE.MathUtils.lerp(
        sheet.squareness,
        tip.squareness,
        mix,
      ),
    };
  }
  return null;
}

function superellipseCoordinate(value: number, squareness: number): number {
  const power = THREE.MathUtils.lerp(1, 0.52, THREE.MathUtils.clamp(squareness, 0, 1));
  return Math.sign(value) * Math.pow(Math.abs(value), power);
}

function smoothstep(value: number): number {
  const clamped = THREE.MathUtils.clamp(value, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function writeCapVertex(
  sample: CartoonSample,
  translation: THREE.Vector3,
  translationImage: CellOffset,
  positions: Float32Array,
  atomIndices: Float32Array,
  imageOffsets: Float32Array,
  progress: Float32Array,
  secondaryStructure: Float32Array,
  secondaryStructureWeights: Float32Array,
  vertex: number,
): void {
  sample.center.clone().add(translation).toArray(positions, vertex * 3);
  atomIndices[vertex] = sample.atomIndex;
  writeImageOffset(sample.image, translationImage, imageOffsets, vertex);
  progress[vertex] = sample.progress;
  secondaryStructure[vertex] = STRUCTURE_CODE[sample.structure];
  writeStructureWeights(
    sample.structureWeights,
    secondaryStructureWeights,
    vertex,
  );
}

function writeStructureWeights(
  weights: readonly [number, number, number],
  values: Float32Array,
  vertex: number,
): void {
  const offset = vertex * 3;
  values[offset] = weights[0];
  values[offset + 1] = weights[1];
  values[offset + 2] = weights[2];
}

function writeImageOffset(
  image: CellOffset,
  translation: CellOffset,
  values: Float32Array,
  vertex: number,
): void {
  const offset = vertex * 3;
  values[offset] = image[0] + translation[0];
  values[offset + 1] = image[1] + translation[1];
  values[offset + 2] = image[2] + translation[2];
}
