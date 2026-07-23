import { describe, expect, it } from "vitest";
import {
  autoProfile,
  filterCommandActions,
  frameMetadata,
  measurementPbc,
  profilePresentation,
  selectionVisibleInImages,
  selectedProfilePresentation,
} from "./App";
import type { FrameData, FrameHeader, SceneCapabilities, ScenePresentation } from "./types";

const presentation: ScenePresentation = {
  mode: "spacefill",
  water: "hide",
  hydrogens: false,
  wrap: "molecule",
  images: { min: [-1, -1, -1], max: [1, 1, 1] },
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

  it("drops selections when their image is no longer displayed", () => {
    const selection = { atom: 3, image: [1, 0, 0] as [number, number, number] };

    expect(selectionVisibleInImages(
      selection,
      [0, 0, 0],
      [1, 1, 1],
      [true, true, true],
    )).toBe(true);
    expect(selectionVisibleInImages(
      selection,
      [0, 0, 0],
      [0, 0, 0],
      [true, true, true],
    )).toBe(false);
    expect(selectionVisibleInImages(
      selection,
      [0, 0, 0],
      [1, 1, 1],
      [false, true, true],
    )).toBe(false);
  });
});

function frameWithHeader(header: Partial<FrameHeader>): FrameData {
  return {
    header: { arrays: [], ...header },
    arrays: new Map(),
  };
}
