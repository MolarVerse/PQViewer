import { describe, expect, it } from "vitest";
import {
  autoProfile,
  parseWorkspacePresentationDefaults,
  profilePresentation,
  renderSizeValidationMessage,
  selectedProfilePresentation,
} from "./App";
import type { SceneCapabilities, ScenePresentation } from "./types";

const presentation: ScenePresentation = {
  mode: "spacefill",
  water: "hide",
  hydrogens: false,
  wrap: "molecule",
  images: { min: [-1, -1, -1], max: [1, 1, 1] },
  cell: false,
  forces: true,
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

  it("restores explicit workspace wrap and color choices for Auto datasets", () => {
    const capabilities: SceneCapabilities = {
      water: false,
      ribbon: false,
      ribbonReason: "Backbone topology unavailable",
      suggestedProfile: "crystal",
    };
    const saved = parseWorkspacePresentationDefaults('{"wrap":"none","color":"residue"}');
    expect(selectedProfilePresentation(
      "auto",
      presentation,
      true,
      false,
      false,
      capabilities,
      saved,
    )).toMatchObject({ wrap: "none", color: "residue", cell: true });
  });

  it("does not apply workspace Auto defaults to an explicit profile", () => {
    const capabilities: SceneCapabilities = {
      water: false,
      ribbon: false,
      ribbonReason: "Backbone topology unavailable",
      suggestedProfile: "crystal",
    };
    expect(selectedProfilePresentation(
      "molecule",
      presentation,
      true,
      false,
      false,
      capabilities,
      { wrap: "none", color: "residue" },
    )).toMatchObject({ wrap: "molecule", color: "element", cell: false });
  });

  it("ignores invalid saved workspace choices", () => {
    expect(parseWorkspacePresentationDefaults('{"wrap":"outside","color":"rainbow"}')).toEqual({});
    expect(parseWorkspacePresentationDefaults("not-json")).toEqual({});
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
});

describe("render size validation", () => {
  it("requires whole-pixel dimensions", () => {
    expect(renderSizeValidationMessage(2400.5, 1800)).toBe("Width must be a whole number of pixels.");
    expect(renderSizeValidationMessage(2400, 1800.25)).toBe("Height must be a whole number of pixels.");
    expect(renderSizeValidationMessage(512.5, 6000.5)).toBe("Width and height must be whole numbers of pixels.");
  });

  it("identifies dimensions below the minimum", () => {
    expect(renderSizeValidationMessage(511, 1800)).toBe("Width must be at least 512 px.");
    expect(renderSizeValidationMessage(2400, 100)).toBe("Height must be at least 512 px.");
    expect(renderSizeValidationMessage(0, 0)).toBe("Width and height must be at least 512 px.");
  });

  it("identifies dimensions above the per-axis maximum", () => {
    expect(renderSizeValidationMessage(6001, 1800)).toBe("Width cannot exceed 6,000 px.");
    expect(renderSizeValidationMessage(2400, 6001)).toBe("Height cannot exceed 6,000 px.");
    expect(renderSizeValidationMessage(7000, 7000)).toBe("Width and height cannot exceed 6,000 px.");
  });

  it("keeps the megapixel limit distinct", () => {
    expect(renderSizeValidationMessage(6000, 5000)).toBe("Maximum output is 24 megapixels.");
    expect(renderSizeValidationMessage(6000, 4000)).toBeNull();
    expect(renderSizeValidationMessage(Number.NaN, 1800)).toBe("Enter a valid width and height.");
  });

  it("accepts exact inclusive boundaries", () => {
    expect(renderSizeValidationMessage(512, 512)).toBeNull();
    expect(renderSizeValidationMessage(6000, 512)).toBeNull();
    expect(renderSizeValidationMessage(6000, 4000)).toBeNull();
    expect(renderSizeValidationMessage(6000, 4001)).toBe("Maximum output is 24 megapixels.");
  });
});
