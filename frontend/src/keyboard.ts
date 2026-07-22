export function advanceFrameIndex(current: number, delta: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  return Math.max(0, Math.min(frameCount - 1, current + delta));
}
