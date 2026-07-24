export type PlaybackMode = "once" | "loop" | "rock";
export type PlaybackDirection = 1 | -1;

export interface PlaybackOptions {
  mode?: PlaybackMode;
  direction?: PlaybackDirection;
  stride?: number;
}

export interface PlaybackStep {
  frameIndex: number;
  direction: PlaybackDirection;
  continuePlaying: boolean;
}

export interface PlaybackSchedule {
  delayMs: number;
  requestTimeMs: number;
}

export const DEFAULT_PLAYBACK_FPS = 12;
export const MIN_PLAYBACK_FPS = 1;
export const MAX_PLAYBACK_FPS = 60;

export function normalizePlaybackFps(
  value: number,
  fallback = DEFAULT_PLAYBACK_FPS,
): number {
  const safeFallback = Number.isFinite(fallback) && fallback > 0
    ? Math.min(MAX_PLAYBACK_FPS, Math.max(MIN_PLAYBACK_FPS, fallback))
    : DEFAULT_PLAYBACK_FPS;

  if (!Number.isFinite(value) || value <= 0) return safeFallback;
  return Math.min(MAX_PLAYBACK_FPS, Math.max(MIN_PLAYBACK_FPS, value));
}

export function playbackIntervalMs(fps: number): number {
  return 1000 / normalizePlaybackFps(fps);
}

export function schedulePlaybackFrame(
  nowMs: number,
  previousRequestTimeMs: number | null,
  fps: number,
): PlaybackSchedule {
  const now = Number.isFinite(nowMs) ? Math.max(0, nowMs) : 0;
  const interval = playbackIntervalMs(fps);
  const previous = (
    previousRequestTimeMs !== null
    && Number.isFinite(previousRequestTimeMs)
    && previousRequestTimeMs >= 0
    && previousRequestTimeMs <= now
  )
    ? previousRequestTimeMs
    : null;
  const target = previous === null ? now + interval : previous + interval;

  if (target <= now) {
    return { delayMs: 0, requestTimeMs: now };
  }
  return {
    delayMs: target - now,
    requestTimeMs: target,
  };
}

export function normalizePlaybackStride(value: number, fallback = 1): number {
  const safeFallback = Number.isFinite(fallback) && fallback > 0
    ? Math.max(1, Math.round(fallback))
    : 1;

  if (!Number.isFinite(value) || value <= 0) return safeFallback;
  return Math.max(1, Math.round(value));
}

export function advancePlaybackFrame(
  frameIndex: number,
  frameCount: number,
  options: PlaybackOptions = {},
): PlaybackStep {
  const count = normalizeFrameCount(frameCount);
  const direction: PlaybackDirection = options.direction === -1 ? -1 : 1;

  if (count < 2) {
    return { frameIndex: 0, direction, continuePlaying: false };
  }

  const lastFrame = count - 1;
  const current = clampFrame(frameIndex, lastFrame);
  const stride = normalizePlaybackStride(options.stride ?? 1);
  const mode = options.mode ?? "loop";

  if (mode === "once") {
    const target = current + direction * stride;
    const reachedEdge = target <= 0 || target >= lastFrame;
    return {
      frameIndex: clampFrame(target, lastFrame),
      direction,
      continuePlaying: !reachedEdge,
    };
  }

  if (mode === "rock") {
    return advanceRockFrame(current, lastFrame, direction, stride);
  }

  return {
    frameIndex: modulo(current + direction * stride, count),
    direction,
    continuePlaying: true,
  };
}

function advanceRockFrame(
  current: number,
  lastFrame: number,
  direction: PlaybackDirection,
  stride: number,
): PlaybackStep {
  const period = lastFrame * 2;
  const phase = direction === 1 ? current : period - current;
  const nextPhase = modulo(phase + stride, period);

  if (nextPhase === 0) {
    return { frameIndex: 0, direction: 1, continuePlaying: true };
  }

  if (nextPhase === lastFrame) {
    return { frameIndex: lastFrame, direction: -1, continuePlaying: true };
  }

  if (nextPhase < lastFrame) {
    return { frameIndex: nextPhase, direction: 1, continuePlaying: true };
  }

  return {
    frameIndex: period - nextPhase,
    direction: -1,
    continuePlaying: true,
  };
}

function normalizeFrameCount(frameCount: number): number {
  if (!Number.isFinite(frameCount) || frameCount <= 0) return 0;
  return Math.floor(frameCount);
}

function clampFrame(frameIndex: number, lastFrame: number): number {
  const index = Number.isFinite(frameIndex) ? Math.round(frameIndex) : 0;
  return Math.min(lastFrame, Math.max(0, index));
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
