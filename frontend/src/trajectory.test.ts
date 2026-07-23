import { describe, expect, it } from "vitest";
import {
  advancePlaybackFrame,
  normalizePlaybackFps,
  normalizePlaybackStride,
  playbackIntervalMs,
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
  });

  it("normalizes stride to a positive integer", () => {
    expect(normalizePlaybackStride(3)).toBe(3);
    expect(normalizePlaybackStride(2.6)).toBe(3);
    expect(normalizePlaybackStride(0, 4)).toBe(4);
    expect(normalizePlaybackStride(-2)).toBe(1);
    expect(normalizePlaybackStride(Number.POSITIVE_INFINITY)).toBe(1);
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
