import { describe, expect, it } from "vitest";
import {
  advanceFrameIndex,
  isApplePlatform,
  parseVimPreference,
  resolveVimNavigation,
  shortcutLabelsForPlatform,
} from "./keyboard";

describe("platform shortcuts", () => {
  it("uses compact Apple labels", () => {
    expect(isApplePlatform("MacIntel")).toBe(true);
    expect(isApplePlatform("iPad")).toBe(true);
    expect(shortcutLabelsForPlatform("macOS")).toEqual({
      commands: "⌘K",
      open: "⌘O",
      export: "⌘⇧S",
    });
  });

  it("uses explicit Control labels on Linux and Windows", () => {
    for (const platform of ["Linux x86_64", "Win32", ""]) {
      expect(shortcutLabelsForPlatform(platform)).toEqual({
        commands: "Ctrl K",
        open: "Ctrl O",
        export: "Ctrl Shift S",
      });
    }
  });
});

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

describe("Vim navigation", () => {
  it("maps horizontal movement", () => {
    expect(resolveVimNavigation("l", null).action).toBe("next-frame");
    expect(resolveVimNavigation("h", null).action).toBe("previous-frame");
    expect(resolveVimNavigation("L", null).action).toBe("next-ten-frames");
    expect(resolveVimNavigation("H", null).action).toBe("previous-ten-frames");
  });

  it("leaves vertical keys available for typing", () => {
    for (const key of ["j", "J", "k", "K"]) {
      expect(resolveVimNavigation(key, null)).toEqual({ action: null, prefix: null });
    }
  });

  it("requires a complete gg sequence and maps G to the end", () => {
    expect(resolveVimNavigation("g", null)).toEqual({ action: null, prefix: "g" });
    expect(resolveVimNavigation("g", "g")).toEqual({ action: "first-frame", prefix: null });
    expect(resolveVimNavigation("G", null).action).toBe("last-frame");
    expect(resolveVimNavigation("x", "g")).toEqual({ action: null, prefix: null });
  });

  it("opens commands with a colon", () => {
    expect(resolveVimNavigation(":", null).action).toBe("commands");
  });

  it("only restores an explicit enabled preference", () => {
    expect(parseVimPreference("true")).toBe(true);
    expect(parseVimPreference("false")).toBe(false);
    expect(parseVimPreference(null)).toBe(false);
  });
});
