import { describe, expect, it } from "vitest";
import { searchCommandActions } from "./commandSearch";

interface Action {
  id: string;
  label: string;
  keywords?: string | readonly string[];
  detail?: string;
  disabled?: boolean;
  run?: () => void;
}

const actions: Action[] = [
  { id: "open", label: "Open trajectory", keywords: "file load", detail: "Ctrl O" },
  { id: "play", label: "Play trajectory", keywords: "movie animation", detail: "Space" },
  { id: "previous", label: "Previous frame", keywords: "back step", detail: "Left" },
  { id: "next", label: "Next frame", keywords: "forward step", detail: "Right" },
  { id: "fit", label: "Fit structure", keywords: "reset camera", detail: "R" },
  { id: "cell", label: "Show cell", keywords: "box periodic pbc", detail: "C" },
  { id: "forces", label: "Show forces", keywords: "vectors arrows", detail: "F" },
  { id: "export", label: "Export figure", keywords: ["render", "image", "publication"], detail: "Ctrl Shift S" },
];

describe("command suggestions", () => {
  it("returns at most six enabled actions for an empty query", () => {
    const result = searchCommandActions(
      [...actions, { id: "disabled", label: "Disabled", disabled: true }],
      "  ",
    );

    expect(result).toHaveLength(6);
    expect(result.map(({ id }) => id)).toEqual([
      "open",
      "play",
      "previous",
      "next",
      "fit",
      "cell",
    ]);
  });

  it("places contextual actions before recent and default suggestions", () => {
    const result = searchCommandActions(actions, "", {
      contextIds: ["next", "play"],
      recentIds: ["export", "next", "fit"],
    });

    expect(result.map(({ id }) => id)).toEqual([
      "next",
      "play",
      "export",
      "fit",
      "open",
      "previous",
    ]);
  });

  it("ignores missing, duplicate, and disabled suggestion ids", () => {
    const result = searchCommandActions(
      [...actions, { id: "pause", label: "Pause trajectory", disabled: true }],
      "",
      {
        contextIds: ["pause", "missing", "next", "next"],
        recentIds: ["pause", "next", "open"],
        limit: 3,
      },
    );

    expect(result.map(({ id }) => id)).toEqual(["next", "open", "play"]);
  });
});

describe("command matching", () => {
  it("shows disabled actions only when their reason should remain discoverable", () => {
    const result = searchCommandActions([
      { id: "show", label: "Show forces" },
      {
        id: "hide",
        label: "Hide forces",
        detail: "No force data",
        disabled: true,
        discoverableWhenDisabled: true,
      },
      { id: "pause", label: "Pause forces", disabled: true },
    ], "forces");

    expect(result.map(({ id }) => id)).toEqual(["show", "hide"]);
    expect(result[1].detail).toBe("No force data");
  });

  it("matches every query term across labels, keywords, and details", () => {
    expect(searchCommandActions(actions, "open file").map(({ id }) => id)).toEqual(["open"]);
    expect(searchCommandActions(actions, "periodic box").map(({ id }) => id)).toEqual(["cell"]);
    expect(searchCommandActions(actions, "ctrl shift").map(({ id }) => id)).toEqual(["export"]);
    expect(searchCommandActions(actions, "trajectory missing")).toEqual([]);
  });

  it("ranks exact and prefix label matches ahead of keyword matches", () => {
    const result = searchCommandActions([
      { id: "keyword", label: "Display controls", keywords: "show scene" },
      { id: "word-prefix", label: "Always show water" },
      { id: "label-prefix", label: "Show forces" },
      { id: "exact", label: "Show" },
    ], "show");

    expect(result.map(({ id }) => id)).toEqual([
      "exact",
      "label-prefix",
      "word-prefix",
      "keyword",
    ]);
  });

  it("uses context, recency, then source order to break equal scores", () => {
    const equal = [
      { id: "one", label: "Alpha one", keywords: "frame" },
      { id: "two", label: "Alpha two", keywords: "frame" },
      { id: "three", label: "Alpha three", keywords: "frame" },
      { id: "four", label: "Alpha four", keywords: "frame" },
    ];

    const result = searchCommandActions(equal, "frame", {
      contextIds: ["three"],
      recentIds: ["two"],
    });

    expect(result.map(({ id }) => id)).toEqual(["three", "two", "one", "four"]);
  });

  it("applies an explicit result limit without exceeding the empty-state cap", () => {
    expect(searchCommandActions(actions, "trajectory", { limit: 1 })).toHaveLength(1);
    expect(searchCommandActions(actions, "", { limit: 99 })).toHaveLength(6);
    expect(searchCommandActions(actions, "", { limit: -1 })).toEqual([]);
  });
});
