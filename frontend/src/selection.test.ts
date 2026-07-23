import { describe, expect, it } from "vitest";
import { measureAtomSelection, updateAtomSelection } from "./selection";

describe("atom selection", () => {
  it("replaces the current selection", () => {
    const current = [4, 2];

    expect(updateAtomSelection(current, 7, "replace")).toEqual([7]);
    expect(current).toEqual([4, 2]);
  });

  it("appends toggled atoms in selection order", () => {
    expect(updateAtomSelection([4, 2], 7, "toggle")).toEqual([4, 2, 7]);
  });

  it("removes an existing atom without reordering the rest", () => {
    expect(updateAtomSelection([4, 2, 7], 2, "toggle")).toEqual([4, 7]);
  });

  it("rejects invalid atom indices and malformed state", () => {
    expect(() => updateAtomSelection([], -1, "replace")).toThrow(RangeError);
    expect(() => updateAtomSelection([], 1.5, "toggle")).toThrow(RangeError);
    expect(() => updateAtomSelection([2, 2], 3, "toggle")).toThrow(
      "Atom selection contains duplicates",
    );
  });
});

describe("atom measurements", () => {
  it("measures distance from two ordered atoms", () => {
    const result = measureAtomSelection([0, 0, 0, 3, 4, 0], [0, 1]);

    expect(result).toEqual({
      ok: true,
      kind: "distance",
      atomIndices: [0, 1],
      value: 5,
      unit: "angstrom",
    });
  });

  it("accepts typed current-frame positions", () => {
    const positions = new Float32Array([0, 0, 0, 0, 0, 2]);

    expect(measureAtomSelection(positions, [0, 1])).toMatchObject({
      ok: true,
      value: 2,
    });
  });

  it("measures the angle at the middle selected atom", () => {
    const positions = [
      1, 0, 0,
      0, 0, 0,
      0, 1, 0,
    ];

    const result = measureAtomSelection(positions, [0, 1, 2]);

    expect(result).toMatchObject({
      ok: true,
      kind: "angle",
      atomIndices: [0, 1, 2],
      unit: "degree",
    });
    if (result.ok) expect(result.value).toBeCloseTo(90, 12);
  });

  it("measures a signed dihedral in selection order", () => {
    const positions = [
      1, 0, 0,
      0, 0, 0,
      0, 1, 0,
      0, 1, 1,
      0, 1, -1,
    ];

    const forward = measureAtomSelection(positions, [0, 1, 2, 3]);
    const mirrored = measureAtomSelection(positions, [0, 1, 2, 4]);

    expect(forward).toMatchObject({ ok: true, kind: "dihedral", unit: "degree" });
    expect(mirrored).toMatchObject({ ok: true, kind: "dihedral", unit: "degree" });
    if (forward.ok && mirrored.ok) {
      expect(forward.value).toBeCloseTo(-90, 12);
      expect(mirrored.value).toBeCloseTo(90, 12);
    }
  });

  it("keeps zero and straight distances or angles valid", () => {
    expect(measureAtomSelection([1, 1, 1, 1, 1, 1], [0, 1])).toMatchObject({
      ok: true,
      value: 0,
    });

    const straight = measureAtomSelection(
      [-1, 0, 0, 0, 0, 0, 1, 0, 0],
      [0, 1, 2],
    );
    expect(straight).toMatchObject({ ok: true, kind: "angle" });
    if (straight.ok) expect(straight.value).toBeCloseTo(180, 12);
  });

  it("reports unsupported selection sizes", () => {
    expect(measureAtomSelection([], [])).toEqual({
      ok: false,
      atomIndices: [],
      reason: "selection-size",
    });
    expect(measureAtomSelection(new Float32Array(15), [0, 1, 2, 3, 4])).toEqual({
      ok: false,
      atomIndices: [0, 1, 2, 3, 4],
      reason: "selection-size",
    });
  });

  it("reports duplicate and out-of-range atom indices", () => {
    const positions = new Float32Array(12);

    expect(measureAtomSelection(positions, [1, 1])).toMatchObject({
      ok: false,
      reason: "duplicate-atoms",
    });
    expect(measureAtomSelection(positions, [-1, 1])).toMatchObject({
      ok: false,
      reason: "invalid-index",
    });
    expect(measureAtomSelection(positions, [0, 4])).toMatchObject({
      ok: false,
      reason: "invalid-index",
    });
  });

  it("reports incomplete and non-finite positions", () => {
    expect(measureAtomSelection([0, 0, 0, 1], [0, 1])).toMatchObject({
      ok: false,
      reason: "invalid-position",
    });
    expect(measureAtomSelection([0, 0, 0, Number.NaN, 0, 0], [0, 1])).toMatchObject({
      ok: false,
      reason: "invalid-position",
    });
    expect(measureAtomSelection([0, 0, 0, Number.POSITIVE_INFINITY, 0, 0], [0, 1]))
      .toMatchObject({
        ok: false,
        reason: "invalid-position",
      });
  });

  it("reports undefined angles and dihedrals", () => {
    expect(
      measureAtomSelection(
        [0, 0, 0, 0, 0, 0, 1, 0, 0],
        [0, 1, 2],
      ),
    ).toMatchObject({ ok: false, reason: "degenerate-geometry" });

    expect(
      measureAtomSelection(
        [0, 0, 0, 1, 0, 0, 2, 0, 0, 2, 1, 0],
        [0, 1, 2, 3],
      ),
    ).toMatchObject({ ok: false, reason: "degenerate-geometry" });
  });
});
