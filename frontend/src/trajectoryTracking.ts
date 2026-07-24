import type { SelectedPositions } from "./api";
import type {
  AtomDisplacementOverlay,
  AtomTrailOverlay,
  TrajectoryOverlays,
} from "./MoleculeScene";
import type { AtomSelection, FrameKey } from "./types";
import { sameFrameKey } from "./trajectoryStudy";
import type { TrackingMode } from "./trajectoryStudy";

export const TRAIL_FRAME_WINDOW = 50;
export const MAX_TRACKED_SELECTIONS = 16;

export type TrackingFrameMismatch = "current" | "reference" | null;

export function trackingFrameIndices(
  mode: TrackingMode,
  currentFrame: number,
  referenceFrame: number | null,
  frameCount: number,
): number[] {
  if (
    mode === "off"
    || !Number.isSafeInteger(currentFrame)
    || currentFrame < 0
    || currentFrame >= frameCount
  ) return [];
  const indices = mode === "trail"
    ? Array.from(
        { length: Math.min(TRAIL_FRAME_WINDOW + 1, currentFrame + 1) },
        (_, offset) => Math.max(0, currentFrame - TRAIL_FRAME_WINDOW) + offset,
      )
    : [currentFrame];
  if (
    mode === "displacement"
    && referenceFrame !== null
    && Number.isSafeInteger(referenceFrame)
    && referenceFrame >= 0
    && referenceFrame < frameCount
  ) {
    indices.push(referenceFrame);
  }
  return [...new Set(indices)].sort((left, right) => left - right);
}

export function trackingFrameMismatch(
  batch: SelectedPositions,
  currentFrame: number,
  currentKey: FrameKey | null,
  referenceFrame: number | null,
  referenceKey: FrameKey | null,
): TrackingFrameMismatch {
  const current = batch.frames.find(({ index }) => index === currentFrame);
  if (currentKey && (!current || !sameFrameKey(current.key, currentKey))) {
    return "current";
  }
  if (referenceFrame !== null && referenceKey) {
    const reference = batch.frames.find(({ index }) => index === referenceFrame);
    if (!reference || !sameFrameKey(reference.key, referenceKey)) {
      return "reference";
    }
  }
  return null;
}

export function trajectoryOverlaysFromPositions(
  batch: SelectedPositions,
  selections: readonly AtomSelection[],
  mode: TrackingMode,
  currentFrame: number,
  referenceFrame: number | null,
): TrajectoryOverlays {
  if (selections.length > MAX_TRACKED_SELECTIONS) {
    throw new RangeError(`Track up to ${MAX_TRACKED_SELECTIONS} selected atoms`);
  }
  const atomOffsets = new Map(
    batch.atomIndices.map((atom, index) => [atom, index]),
  );
  const byFrame = new Map(batch.frames.map((sample) => [sample.index, sample]));
  const current = byFrame.get(currentFrame);
  if (!current) return { trails: [], displacements: [] };

  const trails: AtomTrailOverlay[] = [];
  if (mode === "trail") {
    const samples = batch.frames
      .filter(({ index }) => index <= currentFrame)
      .sort((left, right) => left.index - right.index)
      .slice(-(TRAIL_FRAME_WINDOW + 1));
    for (const selection of selections) {
      const atomOffset = atomOffsets.get(selection.atom);
      if (atomOffset === undefined || samples.length < 2) continue;
      const points = new Float32Array(samples.length * 3);
      samples.forEach(({ positions }, index) => {
        points.set(
          positions.subarray(atomOffset * 3, atomOffset * 3 + 3),
          index * 3,
        );
      });
      trails.push({
        id: selectionId(selection),
        atom: selection.atom,
        image: [...selection.image],
        points,
      });
    }
  }

  const displacements: AtomDisplacementOverlay[] = [];
  if (mode === "displacement" && referenceFrame !== null) {
    const reference = byFrame.get(referenceFrame);
    if (reference) {
      for (const selection of selections) {
        const atomOffset = atomOffsets.get(selection.atom);
        if (atomOffset === undefined) continue;
        const offset = atomOffset * 3;
        displacements.push({
          id: selectionId(selection),
          atom: selection.atom,
          image: [...selection.image],
          from: [
            reference.positions[offset],
            reference.positions[offset + 1],
            reference.positions[offset + 2],
          ],
          to: [
            current.positions[offset],
            current.positions[offset + 1],
            current.positions[offset + 2],
          ],
        });
      }
    }
  }

  return { trails, displacements };
}

function selectionId(selection: AtomSelection): string {
  return `${selection.atom}:${selection.image.join(":")}`;
}
