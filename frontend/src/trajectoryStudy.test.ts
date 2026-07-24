import { describe, expect, it } from "vitest";
import {
  frameMark,
  frameMarkLabel,
  initialTrajectoryStudyState,
  sameFrameKey,
  trajectoryStudyReducer,
} from "./trajectoryStudy";
import type { FrameData, FrameHeader, FrameKey } from "./types";

const key = (
  sourceIndex: number,
  sourceId = "segment-a",
): FrameKey => ({
  source_id: sourceId,
  source_index: sourceIndex,
  segment_index: 0,
  step: sourceIndex * 10,
  time: sourceIndex * 0.5,
  time_unit: "ps",
});

describe("trajectory study state", () => {
  it("keys bookmarks by stable frame identity", () => {
    const first = {
      index: 2,
      key: key(2),
      step: 20,
      time: 1,
      timeUnit: "ps",
    };
    const moved = { ...first, index: 4 };
    const added = trajectoryStudyReducer(
      initialTrajectoryStudyState,
      { type: "toggle-bookmark", mark: first },
    );
    const removed = trajectoryStudyReducer(
      added,
      { type: "toggle-bookmark", mark: moved },
    );

    expect(added.bookmarks).toHaveLength(1);
    expect(removed.bookmarks).toEqual([]);
  });

  it("preserves marks only for a compatible dataset reset", () => {
    const marked = trajectoryStudyReducer(initialTrajectoryStudyState, {
      type: "set-reference",
      mark: { index: 3, key: key(3), step: 30, time: 1.5, timeUnit: "ps" },
    });
    const preserved = trajectoryStudyReducer(marked, {
      type: "reset",
      preserveMarks: true,
    });
    const cleared = trajectoryStudyReducer(marked, { type: "reset" });

    expect(preserved.reference?.index).toBe(3);
    expect(cleared).toBe(initialTrajectoryStudyState);
  });

  it("rejects stale plot progress", () => {
    const plot = {
      requestId: 7,
      kind: "property" as const,
      title: "Property · Temperature",
      xLabel: "Frame",
      yLabel: "Temperature",
      xValues: [1, 2],
      lines: [{ id: "temperature", label: "Temperature", values: [300, 301] }],
      loadedCount: 2,
      totalCount: 2,
      complete: true,
    };
    const opened = trajectoryStudyReducer(initialTrajectoryStudyState, {
      type: "open-plot",
      plot,
    });
    const stale = trajectoryStudyReducer(opened, {
      type: "update-plot",
      plot: { ...plot, requestId: 6, title: "Stale" },
    });

    expect(stale.plot?.title).toBe("Property · Temperature");
  });

  it("keeps the bookmark rail compact", () => {
    let state = initialTrajectoryStudyState;
    for (let index = 0; index < 20; index += 1) {
      state = trajectoryStudyReducer(state, {
        type: "toggle-bookmark",
        mark: {
          index,
          key: key(index),
          step: index * 10,
          time: index * 0.5,
          timeUnit: "ps",
        },
      });
    }

    expect(state.bookmarks).toHaveLength(12);
    expect(state.bookmarks[0].index).toBe(8);
    expect(state.bookmarks.at(-1)?.index).toBe(19);
  });
});

describe("frame marks", () => {
  it("captures canonical identity, step, time, and units", () => {
    const frame = frameWithHeader({
      frame_key: key(4),
      step: 40,
      time: 2,
      scalar_units: { time: "ps" },
      arrays: [],
    });
    const mark = frameMark(4, frame);

    expect(mark).toEqual({
      index: 4,
      key: key(4),
      step: 40,
      time: 2,
      timeUnit: "ps",
    });
    expect(frameMarkLabel(mark!)).toBe("Frame 5 · step 40 · t 2 ps");
  });

  it("compares every stable-key field", () => {
    expect(sameFrameKey(key(2), { ...key(2) })).toBe(true);
    expect(sameFrameKey(key(2), { ...key(2), time: 2 })).toBe(false);
    expect(sameFrameKey(key(2), key(2, "segment-b"))).toBe(false);
  });
});

function frameWithHeader(header: FrameHeader): FrameData {
  return { header, arrays: new Map() };
}
