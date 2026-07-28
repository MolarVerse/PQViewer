import { describe, expect, it } from "vitest";
import {
  cellFromParameters,
  cellMatrix,
  cellParameters,
  frameToExtxyz,
  suggestedCell,
  updateAtomElement,
  updateAtomPosition,
  updateCell,
  validateCell,
} from "./structureEditing";
import type { FrameData, Manifest } from "./types";

const frame = (): FrameData => ({
  header: {
    arrays: [
      {
        name: "positions",
        dtype: "float32",
        shape: [2, 3],
        byte_offset: 0,
        byte_length: 24,
        unit: "angstrom",
      },
      {
        name: "cell",
        dtype: "float32",
        shape: [3, 3],
        byte_offset: 24,
        byte_length: 36,
        unit: "angstrom",
      },
    ],
    pbc: [true, true, true],
  },
  arrays: new Map([
    ["positions", new Float32Array([1, 2, 3, -1, -2, -3])],
    ["cell", new Float32Array([4, 0, 0, 1, 5, 0, 0.5, 1, 6])],
  ]),
});

const manifest: Manifest = {
  schema_version: 1,
  name: "edited.extxyz",
  frame_count: 1,
  topology: {
    atom_count: 2,
    atomic_numbers: [8, 1],
    symbols: ["O", "H"],
  },
};

describe("structure editing", () => {
  it("round-trips triclinic lengths and angles", () => {
    const source = cellMatrix(frame())!;
    const parameters = cellParameters(source);
    const restored = cellFromParameters(parameters);
    expect(cellParameters(restored)).toEqual({
      a: expect.closeTo(parameters.a, 8),
      b: expect.closeTo(parameters.b, 8),
      c: expect.closeTo(parameters.c, 8),
      alpha: expect.closeTo(parameters.alpha, 8),
      beta: expect.closeTo(parameters.beta, 8),
      gamma: expect.closeTo(parameters.gamma, 8),
    });
  });

  it("rejects singular cells", () => {
    expect(() => validateCell([1, 0, 0, 2, 0, 0, 0, 0, 1])).toThrow(
      "non-zero volume",
    );
  });

  it("edits one position without mutating the decoded frame", () => {
    const source = frame();
    const edited = updateAtomPosition(source, 1, [4.5, 5.5, 6.5]);
    expect(Array.from(edited.arrays.get("positions")!)).toEqual([
      1, 2, 3, 4.5, 5.5, 6.5,
    ]);
    expect(Array.from(source.arrays.get("positions")!)).toEqual([
      1, 2, 3, -1, -2, -3,
    ]);
  });

  it("can keep fractional coordinates while changing the cell", () => {
    const source = frame();
    const edited = updateCell(
      source,
      [8, 0, 0, 2, 10, 0, 1, 2, 12],
      [true, false, true],
      true,
    );
    expect(Array.from(edited.arrays.get("positions")!)).toEqual([
      2, 4, 6, -2, -4, -6,
    ]);
    expect(edited.header.pbc).toEqual([true, false, true]);
  });

  it("adds a centered orthorhombic suggestion when no cell exists", () => {
    const source = frame();
    source.arrays.delete("cell");
    expect(suggestedCell(source)).toEqual([8, 0, 0, 0, 10, 0, 0, 0, 12]);
  });

  it("edits element identity without mutating the manifest", () => {
    const edited = updateAtomElement(manifest, 1, "carbon");
    expect(edited.topology.atomic_numbers).toEqual([8, 6]);
    expect(edited.topology.symbols).toEqual(["O", "C"]);
    expect(manifest.topology.symbols).toEqual(["O", "H"]);
  });

  it("writes the edited structure as extended XYZ", () => {
    const editedFrame = updateAtomPosition(frame(), 0, [1.25, 2.5, 3.75]);
    const value = frameToExtxyz(manifest, editedFrame);
    expect(value).toContain('Lattice="4 0 0 1 5 0 0.5 1 6"');
    expect(value).toContain('pbc="T T T"');
    expect(value).toContain("O 1.25 2.5 3.75");
  });
});
