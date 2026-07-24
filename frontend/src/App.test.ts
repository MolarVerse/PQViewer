import { describe, expect, it } from "vitest";
import {
  autoProfile,
  canUseRepeatCounts,
  cellOriginForFrame,
  compactFrameNumber,
  filterCommandActions,
  frameCountLabel,
  frameMetadata,
  meaningfulResidueId,
  measureDisplayedPositions,
  measurementPbc,
  noticeDurationMs,
  profilePresentation,
  repeatCountsFromImages,
  repeatImages,
  sameCellOrigin,
  selectedProfilePresentation,
  usesPeriodicFigureContext,
} from "./App";
import type { FrameData, FrameHeader, SceneCapabilities, ScenePresentation } from "./types";

const presentation: ScenePresentation = {
  mode: "spacefill",
  water: "hide",
  hydrogens: false,
  wrap: "molecule",
  images: { min: [-1, -1, -1], max: [1, 1, 1] },
  cellOrigin: [0, 0, 0],
  mirror: [false, false, false],
  cell: false,
  forces: true,
  velocities: false,
  atomScale: 1,
  bondScale: 1,
  color: "element",
  quality: "auto",
};

describe("scene profiles", () => {
  it("keeps periodic solids on the crystal profile when forces are present", () => {
    const capabilities: SceneCapabilities = {
      water: false,
      ribbon: false,
      ribbonReason: "Backbone topology unavailable",
      suggestedProfile: "crystal",
    };
    expect(autoProfile(capabilities, true, true)).toBe("crystal");
    expect(profilePresentation("crystal", presentation, true, true, capabilities)).toMatchObject({
      wrap: "atom",
      cell: true,
      forces: false,
      images: { min: [0, 0, 0], max: [0, 0, 0] },
    });
  });

  it("keeps fresh Auto defaults until explicitly customized", () => {
    const capabilities: SceneCapabilities = {
      water: false,
      ribbon: false,
      ribbonReason: "Backbone topology unavailable",
      suggestedProfile: "crystal",
    };
    expect(selectedProfilePresentation(
      "auto",
      presentation,
      true,
      false,
      false,
      capabilities,
    )).toMatchObject({ wrap: "atom", color: "element" });
  });

  it("keeps automatic display choices deterministic", () => {
    const capabilities: SceneCapabilities = {
      water: false,
      ribbon: false,
      ribbonReason: "Backbone topology unavailable",
      suggestedProfile: "crystal",
    };
    expect(selectedProfilePresentation(
      "auto",
      presentation,
      true,
      false,
      false,
      capabilities,
    )).toMatchObject({ wrap: "atom", color: "element", cell: true });
  });

  it("prefers an available protein ribbon", () => {
    const capabilities: SceneCapabilities = {
      water: true,
      ribbon: true,
      ribbonReason: "Backbone available",
      suggestedProfile: "protein",
    };
    expect(autoProfile(capabilities, true, true)).toBe("protein");
  });

  it("does not let scalar series choose the structural view", () => {
    const capabilities: SceneCapabilities = {
      water: false,
      ribbon: false,
      ribbonReason: "Backbone topology unavailable",
      suggestedProfile: "molecule",
    };
    expect(autoProfile(capabilities, true, true)).toBe("molecule");
  });

  it("keeps periodic trajectories inside PQ's centered cell", () => {
    const capabilities: SceneCapabilities = {
      water: false,
      ribbon: false,
      ribbonReason: "Backbone topology unavailable",
      suggestedProfile: "molecule",
    };
    expect(profilePresentation("trajectory", presentation, true, true, capabilities)).toMatchObject({
      wrap: "atom",
      cell: true,
      forces: true,
    });
  });
});

describe("command search", () => {
  const actions = [
    { label: "Export figure", keywords: "render image png publication", detail: "Ctrl Shift S" },
    { label: "Representation · Spacefill", keywords: "style atoms bonds" },
    { label: "Show forces", keywords: "vectors arrows", detail: "F" },
  ];

  it("matches labels, scientific aliases, and shortcut details", () => {
    expect(filterCommandActions(actions, "spacefill")).toEqual([actions[1]]);
    expect(filterCommandActions(actions, "publication image")).toEqual([actions[0]]);
    expect(filterCommandActions(actions, "ctrl s")).toEqual([actions[0]]);
  });

  it("returns every action for an empty query and none for an unknown command", () => {
    expect(filterCommandActions(actions, "  ")).toEqual(actions);
    expect(filterCommandActions(actions, "density surface")).toEqual([]);
  });
});

describe("frame labels", () => {
  it("keeps long trajectory counts compact", () => {
    expect(compactFrameNumber(9_999)).toBe("9999");
    expect(compactFrameNumber(10_000)).toBe("10k");
    expect(compactFrameNumber(10_000_000)).toBe("10M");
  });

  it("uses the singular form for one frame", () => {
    expect(frameCountLabel(1)).toBe("1 frame");
    expect(frameCountLabel(2)).toBe("2 frames");
  });
});

describe("notices", () => {
  it("keeps longer messages visible long enough to read", () => {
    expect(noticeDurationMs("Done")).toBe(4_200);
    expect(noticeDurationMs("x".repeat(100))).toBe(7_000);
    expect(noticeDurationMs("x".repeat(1_000))).toBe(10_000);
  });
});

describe("residue identifiers", () => {
  it("hides default zero-only topology values", () => {
    expect(meaningfulResidueId(undefined, 0)).toBeNull();
    expect(meaningfulResidueId([], 0)).toBeNull();
    expect(meaningfulResidueId([0, 0], 0)).toBeNull();
  });

  it("keeps identifiers when the topology carries real residue groups", () => {
    expect(meaningfulResidueId([0, 0, 1, 1], 0)).toBe("0");
    expect(meaningfulResidueId([0, 0, 1, 1], 2)).toBe("1");
    expect(meaningfulResidueId([4, 4], 1)).toBe("4");
    expect(meaningfulResidueId(["", "1"], 0)).toBeNull();
    expect(meaningfulResidueId([" A ", "B"], 0)).toBe("A");
  });
});

describe("frame metadata", () => {
  it("reads canonical header values without dropping scalar compatibility", () => {
    const frame = frameWithHeader({
      step: 40,
      time: 1.25,
      scalars: { step: 39, time: 1 },
    });

    expect(frameMetadata(frame)).toBe("step 40 · t 1.25");
  });

  it("reads step and time from legacy scalar-only packets", () => {
    const frame = frameWithHeader({ scalars: { step: 12, time: 0.5, energy: -2 } });

    expect(frameMetadata(frame)).toBe("step 12 · t 0.5");
    expect(frame.header.scalars?.energy).toBe(-2);
  });
});

describe("measurement periodicity", () => {
  it("keeps explicit low-dimensional PBC without an invertible cell", () => {
    expect(measurementPbc(frameWithHeader({ pbc: [true, false, false] }))).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("uses the displayed triclinic cell for mirrored measurements", () => {
    const positions = new Float64Array([
      -1.02351986, 0.37777104, 0.51216186,
      1.83639872, 0.40532119, -0.91651061,
    ]);
    const mirrored = new Float64Array([
      1.02351986, 0.37777104, 0.51216186,
      -1.83639872, 0.40532119, -0.91651061,
    ]);
    const cell = new Float64Array([
      4, 0, 0,
      1.5, 3, 0,
      0.5, 0.25, 2.5,
    ]);
    const mirroredCell = new Float64Array([
      -4, 0, 0,
      -1.5, 3, 0,
      -0.5, 0.25, 2.5,
    ]);
    const pbc = [true, true, true] as const;
    const normal = measureDisplayedPositions(positions, true, cell, pbc);
    const reflected = measureDisplayedPositions(mirrored, true, mirroredCell, pbc);
    const staleCell = measureDisplayedPositions(mirrored, true, cell, pbc);

    expect(normal.ok).toBe(true);
    expect(reflected.ok).toBe(true);
    expect(staleCell.ok).toBe(true);
    if (!normal.ok || !reflected.ok || !staleCell.ok) return;
    expect(reflected.value).toBeCloseTo(normal.value, 7);
    expect(staleCell.value).not.toBeCloseTo(normal.value, 3);
  });

});

describe("periodic display controls", () => {
  const cell = new Float32Array([
    4, 0, 0,
    1, 3, 0,
    0.5, 0.25, 2.5,
  ]);
  const positions = new Float32Array([
    2.8, -0.3, 3,
    -0.5, 1.15, -0.5,
  ]);
  const frame: FrameData = {
    header: { arrays: [], pbc: [true, true, true] },
    arrays: new Map([
      ["positions", positions],
      ["cell", cell],
    ]),
  };

  it("centers triclinic cells from immutable source coordinates", () => {
    const structure = cellOriginForFrame(frame);
    expect(structure?.[0]).toBeCloseTo(0.2, 6);
    expect(structure?.[1]).toBeCloseTo(0.1, 6);
    expect(structure?.[2]).toBeCloseTo(0.5, 6);

    const selection = cellOriginForFrame(frame, [{ atom: 0, image: [1, 0, -1] }]);
    expect(selection?.[0]).toBeCloseTo(1.6, 6);
    expect(selection?.[1]).toBeCloseTo(-0.2, 6);
    expect(selection?.[2]).toBeCloseTo(0.2, 6);
    expect(sameCellOrigin(selection!, [1.6, -0.2, 0.2])).toBe(true);
  });

  it("keeps repeats bounded by PBC and the atom budget", () => {
    expect(repeatImages([3, 3, 3], [true, false, true])).toEqual({
      min: [-1, 0, -1],
      max: [1, 0, 1],
    });
    expect(repeatImages([2, 4, 5], [true, true, true])).toEqual({
      min: [0, -1, -2],
      max: [1, 2, 2],
    });
    expect(repeatCountsFromImages(
      { min: [-1, -1, -1], max: [1, 1, 1] },
      [true, false, true],
    )).toEqual([3, 1, 3]);
    expect(canUseRepeatCounts([5, 5, 5], [true, true, true], 1_000)).toBe(true);
    expect(canUseRepeatCounts([5, 5, 5], [true, true, true], 10_000)).toBe(false);
    expect(canUseRepeatCounts([2, 1, 1], [false, true, true], 10)).toBe(false);
  });

  it("includes periodic context in atom-wrapped and unwrapped figures", () => {
    expect(usesPeriodicFigureContext(
      { ...presentation, mode: "ball-stick", wrap: "atom" },
      [true, false, false],
    )).toBe(true);
    expect(usesPeriodicFigureContext(
      { ...presentation, mode: "ball-stick", wrap: "unwrapped" },
      [true, false, false],
    )).toBe(true);
    expect(usesPeriodicFigureContext(
      { ...presentation, mode: "ball-stick", wrap: "molecule" },
      [true, false, false],
    )).toBe(false);
    expect(usesPeriodicFigureContext(
      { ...presentation, mode: "spacefill", wrap: "unwrapped" },
      [true, false, false],
    )).toBe(false);
  });
});

function frameWithHeader(header: Partial<FrameHeader>): FrameData {
  return {
    header: { arrays: [], ...header },
    arrays: new Map(),
  };
}
