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
      customize: "⌘,",
      open: "⌘O",
      render: "⌘⇧S",
    });
  });

  it("uses explicit Control labels on Linux and Windows", () => {
    for (const platform of ["Linux x86_64", "Win32", ""]) {
      expect(shortcutLabelsForPlatform(platform)).toEqual({
        commands: "Ctrl K",
        customize: "Ctrl ,",
        open: "Ctrl O",
        render: "Ctrl Shift S",
      });
    }
  });
});

describe("Vim navigation", () => {
  it("accumulates rapid frame steps and clamps at trajectory bounds", () => {
    const final = Array.from({ length: 200 }).reduce<number>((frame) => advanceFrameIndex(frame, 1, 100), 0);
    expect(final).toBe(99);
    expect(advanceFrameIndex(0, -10, 100)).toBe(0);
  });

  it("maps trajectory movement and endpoints", () => {
    expect(resolveVimNavigation("j", null).action).toBe("next-frame");
    expect(resolveVimNavigation("k", null).action).toBe("previous-frame");
    expect(resolveVimNavigation("J", null).action).toBe("next-ten-frames");
    expect(resolveVimNavigation("K", null).action).toBe("previous-ten-frames");
    expect(resolveVimNavigation("G", null).action).toBe("last-frame");
  });

  it("requires a complete gg sequence and cancels unrelated prefixes", () => {
    expect(resolveVimNavigation("g", null)).toEqual({ action: null, prefix: "g" });
    expect(resolveVimNavigation("g", "g")).toEqual({ action: "first-frame", prefix: null });
    expect(resolveVimNavigation("x", "g")).toEqual({ action: null, prefix: null });
  });

  it("opens commands with a colon", () => {
    expect(resolveVimNavigation(":", null).action).toBe("commands");
  });

  it("only restores an explicit enabled preference", () => {
    expect(parseVimPreference("true")).toBe(true);
    expect(parseVimPreference("false")).toBe(false);
    expect(parseVimPreference(null)).toBe(false);
    expect(parseVimPreference("1")).toBe(false);
  });
});
