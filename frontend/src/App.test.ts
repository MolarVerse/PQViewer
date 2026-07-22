import { describe, expect, it } from "vitest";
import {
  autoProfile,
  profilePresentation,
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
