import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDmolScenePlan } from "./renderers/threeDmolModel";
import { prepareScene, prepareTopology } from "./scene/model";
import { updateAtomElement } from "./structureEditing";
import type { FrameData, Manifest, ScenePresentation } from "./types";

describe("element editing", () => {
  it("rebuilds a periodic perovskite model", () => {
    const lines = readFileSync("../examples/strontium-titanate.extxyz", "utf8")
      .trim()
      .split(/\n/);
    const atoms = lines.slice(2).map((line) => line.trim().split(/\s+/));
    const symbols = atoms.map(([symbol]) => symbol);
    const numbers: Record<string, number> = { O: 8, Ti: 22, Sr: 38 };
    const manifest: Manifest = {
      schema_version: 1,
      name: "strontium-titanate.extxyz",
      frame_count: 1,
      topology: {
        atom_count: atoms.length,
        symbols,
        atomic_numbers: symbols.map((symbol) => numbers[symbol]),
      },
    };
    const frame: FrameData = {
      header: { arrays: [], pbc: [true, true, true] },
      arrays: new Map([
        ["positions", new Float32Array(atoms.flatMap((row) => row.slice(1).map(Number)))],
        ["cell", new Float32Array([7.81, 0, 0, 0, 7.81, 0, 0, 0, 7.81])],
      ]),
    };
    const presentation: ScenePresentation = {
      mode: "polyhedra",
      water: "show",
      hydrogens: true,
      wrap: "atom",
      images: { min: [0, 0, 0], max: [0, 0, 0] },
      cellOrigin: [0, 0, 0],
      mirror: [false, false, false],
      cell: true,
      bonds: false,
      forces: false,
      velocities: false,
      atomScale: 0.72,
      bondScale: 0.52,
      color: "element",
      quality: "auto",
    };
    const edited = updateAtomElement(manifest, 0, "Ca");
    const topology = prepareTopology(edited, frame);
    const scene = prepareScene(edited, frame, presentation, topology);
    if (!scene) throw new Error("Edited scene was not prepared");
    const plan = buildDmolScenePlan(edited, scene, presentation);
    const sourceScene = prepareScene(
      manifest,
      frame,
      presentation,
      prepareTopology(manifest, frame),
    );
    if (!sourceScene) throw new Error("Source scene was not prepared");
    expect(plan.atoms[0].elem).toBe("Ca");
    expect(plan.layoutKey).not.toBe(
      buildDmolScenePlan(manifest, sourceScene, presentation).layoutKey,
    );
  });
});
