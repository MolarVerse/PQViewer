import { describe, expect, it } from "vitest";
import { advanceFrameIndex } from "./keyboard";

describe("trajectory stepping", () => {
  it("moves within trajectory bounds", () => {
    expect(advanceFrameIndex(5, 1, 10)).toBe(6);
    expect(advanceFrameIndex(5, -1, 10)).toBe(4);
  });

  it("clamps at the first and last frame", () => {
    expect(advanceFrameIndex(0, -10, 100)).toBe(0);
    expect(advanceFrameIndex(99, 10, 100)).toBe(99);
    expect(advanceFrameIndex(0, 1, 0)).toBe(0);
  });
});
