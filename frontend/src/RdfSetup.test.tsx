import { describe, expect, it } from "vitest";
import { buildRdfSetupValue } from "./RdfSetup";

describe("RDF setup", () => {
  it("builds a compact request with explicit atom indices", () => {
    const value = buildRdfSetupValue({
      frameCount: 250,
      reference: { id: "selected", label: "Selection", atomIndices: [1, 3] },
      target: { id: "oxygen", label: "Oxygen", atomIndices: [0, 2] },
      frames: "all",
      bins: 200,
      initialView: "rdf",
    });

    expect(value).toEqual({
      reference: expect.objectContaining({ atomIndices: [1, 3] }),
      target: expect.objectContaining({ atomIndices: [0, 2] }),
      frameStart: 0,
      frameStop: 250,
      frameStep: 1,
      bins: 200,
      rMax: undefined,
      initialView: "rdf",
    });
  });

  it("samples oversized trajectories within the backend frame limit", () => {
    const value = buildRdfSetupValue({
      frameCount: 50_000,
      reference: { id: "selected", label: "Selection", atomIndices: [1] },
      target: { id: "oxygen", label: "Oxygen", atomIndices: [0] },
      frames: "all",
      bins: 200,
      initialView: "rdf",
    });

    expect(value).toEqual(expect.objectContaining({
      frameStart: 0,
      frameStop: 50_000,
      frameStep: 5,
    }));
  });
});
