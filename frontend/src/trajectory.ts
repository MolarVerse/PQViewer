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
  stepCount: number;
}

export type PlaybackTick = {
  committed: false;
  schedule: PlaybackSchedule;
  step: null;
} | {
  committed: true;
  schedule: PlaybackSchedule;
  step: PlaybackStep;
};

export interface PlaybackTickHandlers {
  onStep: (step: PlaybackStep) => void;
  onPulse: () => void;
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
  if (previous === null) {
    return {
      delayMs: interval,
      requestTimeMs: now + interval,
      stepCount: 1,
    };
  }

  const elapsedIntervals = Math.floor(
    (Math.max(0, now - previous) + interval * 1e-9) / interval,
  );
  const stepCount = Math.max(1, elapsedIntervals);
  const target = previous + stepCount * interval;
  return {
    delayMs: Math.max(0, target - now),
    requestTimeMs: target,
    stepCount,
  };
}

export function playbackTimerDelay(delayMs: number): number {
  return Math.ceil(Math.max(0, Number.isFinite(delayMs) ? delayMs : 0));
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

export function advanceScheduledPlaybackFrame(
  frameIndex: number,
  frameCount: number,
  options: PlaybackOptions,
  schedule: Pick<PlaybackSchedule, "stepCount">,
): PlaybackStep {
  return advancePlaybackFrame(frameIndex, frameCount, {
    ...options,
    stride: normalizePlaybackStride(options.stride ?? 1)
      * normalizePlaybackStride(schedule.stepCount),
  });
}

export function runScheduledPlaybackTick(
  nowMs: number,
  requestAnchorMs: number,
  fps: number,
  frameIndex: number,
  frameCount: number,
  options: PlaybackOptions,
  handlers: PlaybackTickHandlers,
): PlaybackTick {
  const schedule = schedulePlaybackFrame(nowMs, requestAnchorMs, fps);
  if (schedule.delayMs > 0) {
    return { committed: false, schedule, step: null };
  }
  const step = advanceScheduledPlaybackFrame(
    frameIndex,
    frameCount,
    options,
    schedule,
  );
  handlers.onStep(step);
  handlers.onPulse();
  return { committed: true, schedule, step };
}

export function playbackPrefetchIndices(
  frameIndex: number,
  frameCount: number,
  options: PlaybackOptions,
  limit = 4,
): number[] {
  const count = normalizeFrameCount(frameCount);
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (count < 2 || maximum === 0) return [];

  let current = clampFrame(frameIndex, count - 1);
  let direction: PlaybackDirection = options.direction === -1 ? -1 : 1;
  const seen = new Set([current]);
  const indices: number[] = [];
  for (let ahead = 0; ahead < maximum; ahead += 1) {
    const next = advancePlaybackFrame(current, count, { ...options, direction });
    if (seen.has(next.frameIndex)) break;
    seen.add(next.frameIndex);
    indices.push(next.frameIndex);
    current = next.frameIndex;
    direction = next.direction;
    if (!next.continuePlaying) break;
  }
  return indices;
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
