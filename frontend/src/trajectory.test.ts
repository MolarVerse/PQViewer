import { describe, expect, it } from "vitest";
import {
  advancePlaybackFrame,
  advanceScheduledPlaybackFrame,
  normalizePlaybackFps,
  normalizePlaybackStride,
  playbackPrefetchIndices,
  playbackIntervalMs,
  playbackTimerDelay,
  runScheduledPlaybackTick,
  schedulePlaybackFrame,
  type PlaybackDirection,
} from "./trajectory";

describe("playback timing", () => {
  it("normalizes invalid and extreme frame rates", () => {
    expect(normalizePlaybackFps(Number.NaN)).toBe(12);
    expect(normalizePlaybackFps(0, 24)).toBe(24);
    expect(normalizePlaybackFps(0.5)).toBe(1);
    expect(normalizePlaybackFps(29.97)).toBe(29.97);
    expect(normalizePlaybackFps(120)).toBe(60);
    expect(normalizePlaybackFps(Number.NaN, Number.NaN)).toBe(12);
  });

  it("converts normalized frame rates to timer intervals", () => {
    expect(playbackIntervalMs(8)).toBe(125);
    expect(playbackIntervalMs(0)).toBeCloseTo(1000 / 12);
    expect(playbackTimerDelay(1000 / 60)).toBe(17);
    expect(playbackTimerDelay(Number.NaN)).toBe(0);
  });

  it("subtracts frame-loading time from the next playback delay", () => {
    const schedule = schedulePlaybackFrame(106, 100, 60);

    expect(schedule.delayMs).toBeCloseTo(1000 / 60 - 6);
    expect(schedule.requestTimeMs).toBeCloseTo(100 + 1000 / 60);
    expect(schedule.stepCount).toBe(1);
  });

  it("keeps playback aligned to its monotonic request clock", () => {
    const first = schedulePlaybackFrame(100, null, 30);
    const second = schedulePlaybackFrame(140, first.requestTimeMs, 30);

    expect(first.delayMs).toBeCloseTo(1000 / 30);
    expect(first.requestTimeMs).toBeCloseTo(100 + 1000 / 30);
    expect(first.stepCount).toBe(1);
    expect(second.delayMs).toBeCloseTo(100 + 2000 / 30 - 140);
    expect(second.requestTimeMs).toBeCloseTo(100 + 2000 / 30);
    expect(second.stepCount).toBe(1);
  });

  it("skips overdue intermediate frames without a catch-up burst", () => {
    const overdue = schedulePlaybackFrame(470, 100, 10);
    const following = schedulePlaybackFrame(
      470,
      overdue.requestTimeMs,
      10,
    );

    expect(overdue).toEqual({
      delayMs: 0,
      requestTimeMs: 400,
      stepCount: 3,
    });
    expect(following).toEqual({
      delayMs: 30,
      requestTimeMs: 500,
      stepCount: 1,
    });
  });

  it("keeps exact playback boundaries on the original phase", () => {
    expect(schedulePlaybackFrame(400, 100, 10)).toEqual({
      delayMs: 0,
      requestTimeMs: 400,
      stepCount: 3,
    });
  });

  it("restarts safely when the monotonic clock is unavailable or resets", () => {
    expect(schedulePlaybackFrame(Number.NaN, 50, 10)).toEqual({
      delayMs: 100,
      requestTimeMs: 100,
      stepCount: 1,
    });
    expect(schedulePlaybackFrame(20, 50, 10)).toEqual({
      delayMs: 100,
      requestTimeMs: 120,
      stepCount: 1,
    });
  });

  it("normalizes stride to a positive integer", () => {
    expect(normalizePlaybackStride(3)).toBe(3);
    expect(normalizePlaybackStride(2.6)).toBe(3);
    expect(normalizePlaybackStride(0, 4)).toBe(4);
    expect(normalizePlaybackStride(-2)).toBe(1);
    expect(normalizePlaybackStride(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("scheduled playback", () => {
  it("composes missed clock steps with the selected stride", () => {
    expect(advanceScheduledPlaybackFrame(
      8,
      10,
      { mode: "loop", stride: 1 },
      { stepCount: 3 },
    )).toEqual({
      frameIndex: 1,
      direction: 1,
      continuePlaying: true,
    });
    expect(advanceScheduledPlaybackFrame(
      4,
      10,
      { mode: "once", stride: 2 },
      { stepCount: 3 },
    )).toEqual({
      frameIndex: 9,
      direction: 1,
      continuePlaying: false,
    });
    expect(advanceScheduledPlaybackFrame(
      3,
      5,
      { mode: "rock", stride: 2 },
      { stepCount: 3 },
    )).toEqual(advancePlaybackFrame(3, 5, {
      mode: "rock",
      stride: 6,
    }));
  });

  it("prefetches in the active playback direction", () => {
    expect(playbackPrefetchIndices(0, 100, {
      mode: "loop",
      direction: -1,
      stride: 1,
    })).toEqual([99, 98, 97, 96]);
    expect(playbackPrefetchIndices(4, 5, {
      mode: "rock",
      direction: -1,
      stride: 1,
    })).toEqual([3, 2, 1, 0]);
    expect(playbackPrefetchIndices(7, 10, {
      mode: "once",
      stride: 2,
    })).toEqual([9]);
  });

  it("catches up before committing a delayed timer tick", () => {
    const steps: number[] = [];
    let pulses = 0;
    const tick = runScheduledPlaybackTick(
      510,
      100,
      10,
      2,
      10,
      { mode: "loop", stride: 1 },
      {
        onStep: (step) => steps.push(step.frameIndex),
        onPulse: () => { pulses += 1; },
      },
    );

    expect(tick.schedule).toEqual({
      delayMs: 0,
      requestTimeMs: 500,
      stepCount: 4,
    });
    expect(tick.committed).toBe(true);
    expect(steps).toEqual([6]);
    expect(pulses).toBe(1);
  });

  it("pulses when a complete loop leaves the frame unchanged", () => {
    const frames: number[] = [];
    let pulses = 0;
    const tick = runScheduledPlaybackTick(
      600,
      100,
      10,
      3,
      5,
      { mode: "loop", stride: 1 },
      {
        onStep: (step) => frames.push(step.frameIndex),
        onPulse: () => { pulses += 1; },
      },
    );

    if (!tick.committed) throw new Error("Expected a committed playback tick");
    expect(tick.schedule.stepCount).toBe(5);
    expect(tick.step.frameIndex).toBe(3);
    expect(frames).toEqual([3]);
    expect(pulses).toBe(1);
  });

  it("defers an early timer without advancing or pulsing", () => {
    const frames: number[] = [];
    let pulses = 0;
    const tick = runScheduledPlaybackTick(
      116,
      100,
      60,
      3,
      10,
      { mode: "loop" },
      {
        onStep: (step) => frames.push(step.frameIndex),
        onPulse: () => { pulses += 1; },
      },
    );

    expect(tick.committed).toBe(false);
    expect(tick.schedule.delayMs).toBeGreaterThan(0);
    expect(frames).toEqual([]);
    expect(pulses).toBe(0);
  });
});

describe("once playback", () => {
  it("advances by the selected stride", () => {
    expect(advancePlaybackFrame(2, 10, { mode: "once", stride: 3 })).toEqual({
      frameIndex: 5,
      direction: 1,
      continuePlaying: true,
    });
  });

  it("stops at an edge without overshooting", () => {
    expect(advancePlaybackFrame(7, 10, { mode: "once", stride: 8 })).toEqual({
      frameIndex: 9,
      direction: 1,
      continuePlaying: false,
    });
    expect(advancePlaybackFrame(2, 10, {
      mode: "once",
      direction: -1,
      stride: 3,
    })).toEqual({
      frameIndex: 0,
      direction: -1,
      continuePlaying: false,
    });
  });

  it("can move inward from an edge before stopping at the opposite edge", () => {
    expect(advancePlaybackFrame(9, 10, {
      mode: "once",
      direction: -1,
      stride: 2,
    })).toEqual({
      frameIndex: 7,
      direction: -1,
      continuePlaying: true,
    });
  });
});

describe("loop playback", () => {
  it("wraps in both directions", () => {
    expect(advancePlaybackFrame(8, 10, { mode: "loop", stride: 3 })).toEqual({
      frameIndex: 1,
      direction: 1,
      continuePlaying: true,
    });
    expect(advancePlaybackFrame(1, 10, {
      mode: "loop",
      direction: -1,
      stride: 3,
    })).toEqual({
      frameIndex: 8,
      direction: -1,
      continuePlaying: true,
    });
  });

  it("supports strides spanning complete loops", () => {
    expect(advancePlaybackFrame(3, 5, { mode: "loop", stride: 10 })).toEqual({
      frameIndex: 3,
      direction: 1,
      continuePlaying: true,
    });
  });
});

describe("rock playback", () => {
  it("changes direction when it reaches either edge", () => {
    const atEnd = advancePlaybackFrame(3, 5, { mode: "rock" });
    expect(atEnd).toEqual({
      frameIndex: 4,
      direction: -1,
      continuePlaying: true,
    });

    expect(advancePlaybackFrame(atEnd.frameIndex, 5, {
      mode: "rock",
      direction: atEnd.direction,
    })).toEqual({
      frameIndex: 3,
      direction: -1,
      continuePlaying: true,
    });

    expect(advancePlaybackFrame(1, 5, {
      mode: "rock",
      direction: -1,
    })).toEqual({
      frameIndex: 0,
      direction: 1,
      continuePlaying: true,
    });
  });

  it("reflects stride across an edge", () => {
    expect(advancePlaybackFrame(3, 5, { mode: "rock", stride: 3 })).toEqual({
      frameIndex: 2,
      direction: -1,
      continuePlaying: true,
    });
  });

  it("remains deterministic across multiple reflections", () => {
    expect(advancePlaybackFrame(1, 5, { mode: "rock", stride: 18 })).toEqual({
      frameIndex: 3,
      direction: 1,
      continuePlaying: true,
    });
  });

  it("produces a stable frame and direction sequence", () => {
    let frameIndex = 0;
    let direction: PlaybackDirection = 1;
    const sequence: Array<[number, PlaybackDirection]> = [];

    for (let step = 0; step < 5; step += 1) {
      const next = advancePlaybackFrame(frameIndex, 5, {
        mode: "rock",
        direction,
        stride: 2,
      });
      frameIndex = next.frameIndex;
      direction = next.direction;
      sequence.push([frameIndex, direction]);
    }

    expect(sequence).toEqual([
      [2, 1],
      [4, -1],
      [2, -1],
      [0, 1],
      [2, 1],
    ]);
  });
});

describe("playback edge cases", () => {
  it("stops when there are fewer than two frames", () => {
    expect(advancePlaybackFrame(7, 0)).toEqual({
      frameIndex: 0,
      direction: 1,
      continuePlaying: false,
    });
    expect(advancePlaybackFrame(7, 1, { direction: -1 })).toEqual({
      frameIndex: 0,
      direction: -1,
      continuePlaying: false,
    });
  });

  it("normalizes invalid frame input before advancing", () => {
    expect(advancePlaybackFrame(Number.NaN, 5, { mode: "once" })).toEqual({
      frameIndex: 1,
      direction: 1,
      continuePlaying: true,
    });
    expect(advancePlaybackFrame(99, 5, {
      mode: "once",
      direction: -1,
    })).toEqual({
      frameIndex: 3,
      direction: -1,
      continuePlaying: true,
    });
  });
});
