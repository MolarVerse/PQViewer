import { describe, expect, it } from "vitest";
import {
  measureAtomSelection,
  selectedAtomPositions,
  updateAtomSelection,
  updateSceneSelection,
} from "./selection";

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

describe("periodic image selection", () => {
  const primary = { atom: 4, image: [0, 0, 0] as [number, number, number] };
  const replica = { atom: 4, image: [1, -1, 0] as [number, number, number] };

  it("treats replicas of the same atom as distinct picks", () => {
    expect(updateSceneSelection([primary], replica, "toggle")).toEqual([primary, replica]);
    expect(updateSceneSelection([primary, replica], replica, "toggle")).toEqual([primary]);
  });

  it("copies image offsets instead of retaining mutable input", () => {
    const result = updateSceneSelection([], replica, "replace");
    replica.image[0] = 2;

    expect(result).toEqual([{ atom: 4, image: [1, -1, 0] }]);
    replica.image[0] = 1;
  });

  it("rejects malformed or duplicate image selections", () => {
    expect(() => updateSceneSelection(
      [{ atom: 1, image: [0, 0, 0] }, { atom: 1, image: [0, 0, 0] }],
      primary,
      "toggle",
    )).toThrow("Atom selection contains duplicates");
    expect(() => updateSceneSelection(
      [],
      { atom: 1, image: [0.5, 0, 0] },
      "replace",
    )).toThrow(RangeError);
  });

  it("places selected replicas in their displayed cells", () => {
    const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
    const cell = new Float32Array([
      10, 0, 0,
      2, 8, 0,
      1, 1, 6,
    ]);

    expect(selectedAtomPositions(
      positions,
      [
        { atom: 0, image: [0, 0, 0] },
        { atom: 1, image: [1, -1, 2] },
      ],
      cell,
    )).toEqual(new Float64Array([
      1, 2, 3,
      14, -1, 18,
    ]));
  });

  it("measures repeated images directly or by minimum image", () => {
    const cell = new Float32Array([
      10, 0, 0,
      0, 10, 0,
      0, 0, 10,
    ]);
    const points = selectedAtomPositions(
      new Float32Array([1, 2, 3]),
      [
        { atom: 0, image: [0, 0, 0] },
        { atom: 0, image: [0, 1, 0] },
      ],
      cell,
    )!;

    expect(measureAtomSelection(points, [0, 1])).toMatchObject({ ok: true, value: 10 });
    expect(measureAtomSelection(points, [0, 1], {
      mode: "minimum-image",
      cell,
      pbc: [true, true, true],
    })).toMatchObject({ ok: true, value: 0 });
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

describe("periodic atom measurements", () => {
  const triclinicCell = [
    10, 0, 0,
    2, 8, 0,
    1, 1, 6,
  ];

  const minimumImage = (
    cell: ArrayLike<number> = triclinicCell,
    pbc: readonly [boolean, boolean, boolean] = [true, true, true],
  ) => ({
    mode: "minimum-image" as const,
    cell,
    pbc,
  });

  const toCartesian = (
    fractional: readonly [number, number, number],
    cell: ArrayLike<number> = triclinicCell,
  ): [number, number, number] => [
    fractional[0] * cell[0] + fractional[1] * cell[3] + fractional[2] * cell[6],
    fractional[0] * cell[1] + fractional[1] * cell[4] + fractional[2] * cell[7],
    fractional[0] * cell[2] + fractional[1] * cell[5] + fractional[2] * cell[8],
  ];

  it("measures the nearest periodic distance without changing direct mode", () => {
    const positions = [4.8, 0, 0, -4.8, 0, 0];
    const cell = [
      10, 0, 0,
      0, 10, 0,
      0, 0, 10,
    ];

    const direct = measureAtomSelection(positions, [0, 1]);
    const periodic = measureAtomSelection(positions, [0, 1], minimumImage(cell));

    expect(direct).toMatchObject({ ok: true, value: 9.6 });
    expect(periodic).toMatchObject({ ok: true, kind: "distance" });
    if (periodic.ok) expect(periodic.value).toBeCloseTo(0.4, 12);
  });

  it("uses only axes marked as periodic", () => {
    const positions = [4.8, 4.8, 0, -4.8, -4.8, 0];
    const cell = [
      10, 0, 0,
      0, 10, 0,
      0, 0, 10,
    ];

    const result = measureAtomSelection(
      positions,
      [0, 1],
      minimumImage(cell, [true, false, false]),
    );

    expect(result).toMatchObject({ ok: true, kind: "distance" });
    if (result.ok) expect(result.value).toBeCloseTo(Math.hypot(0.4, 9.6), 12);
  });

  it("supports one- and two-dimensional periodic cells", () => {
    const oneDimensional = [
      10, 0, 0,
      0, 0, 0,
      0, 0, 0,
    ];
    const oneDimensionalResult = measureAtomSelection(
      [4.8, 1, 2, -4.8, 1, 2],
      [0, 1],
      minimumImage(oneDimensional, [true, false, false]),
    );
    expect(oneDimensionalResult).toMatchObject({ ok: true, kind: "distance" });
    if (oneDimensionalResult.ok) {
      expect(oneDimensionalResult.value).toBeCloseTo(0.4, 12);
    }

    const twoDimensional = [
      10, 0, 0,
      0, 10, 0,
      0, 0, 0,
    ];
    const twoDimensionalResult = measureAtomSelection(
      [4.8, 4.8, 2, -4.8, -4.8, 2],
      [0, 1],
      minimumImage(twoDimensional, [true, true, false]),
    );
    expect(twoDimensionalResult).toMatchObject({ ok: true, kind: "distance" });
    if (twoDimensionalResult.ok) {
      expect(twoDimensionalResult.value).toBeCloseTo(Math.hypot(0.4, 0.4), 12);
    }
  });

  it("measures a triclinic angle across two centered cell faces", () => {
    const center: [number, number, number] = [0.48, 0.48, 0];
    const first: [number, number, number] = [-0.48, 0.48, 0];
    const last: [number, number, number] = [0.47, -0.47, 0];
    const positions = [
      ...toCartesian(first),
      ...toCartesian(center),
      ...toCartesian(last),
    ];

    const result = measureAtomSelection(positions, [0, 1, 2], minimumImage());

    expect(result).toMatchObject({ ok: true, kind: "angle" });
    if (result.ok) expect(result.value).toBeCloseTo(90, 12);
  });

  it("unwraps each ordered bond before measuring a signed dihedral", () => {
    const a = [1, 0, 0] as const;
    const b = [0, 0, 0] as const;
    const c = [0, 1, 0] as const;
    const d = [0, 1, 1] as const;
    const shifted = (
      point: readonly [number, number, number],
      image: readonly [number, number, number],
    ) => {
      const translation = toCartesian(image);
      return point.map((value, axis) => value + translation[axis]);
    };
    const positions = [
      ...shifted(a, [2, 0, 0]),
      ...shifted(b, [2, 0, 0]),
      ...shifted(c, [0, -3, 0]),
      ...shifted(d, [0, -3, 4]),
    ];

    const result = measureAtomSelection(positions, [0, 1, 2, 3], minimumImage());

    expect(result).toMatchObject({ ok: true, kind: "dihedral" });
    if (result.ok) expect(result.value).toBeCloseTo(-90, 12);
  });

  it("finds the exact image in an unreduced triclinic cell", () => {
    const cell = [
      1, 0, 0,
      10, 1, 0,
      0, 0, 5,
    ];
    const positions = [0, 0, 0, ...toCartesian([0, 0.49, 0], cell)];

    const result = measureAtomSelection(
      positions,
      [0, 1],
      minimumImage(cell, [true, true, false]),
    );

    expect(result).toMatchObject({ ok: true, kind: "distance" });
    if (result.ok) expect(result.value).toBeCloseTo(Math.hypot(0.1, 0.49), 12);
  });

  it("keeps non-periodic measurements direct even in minimum-image mode", () => {
    const result = measureAtomSelection(
      [0, 0, 0, 3, 4, 0],
      [0, 1],
      minimumImage([], [false, false, false]),
    );

    expect(result).toMatchObject({ ok: true, value: 5 });
  });

  it("rejects malformed or singular periodic cells", () => {
    const singularCell = [
      1, 0, 0,
      2, 0, 0,
      0, 0, 1,
    ];

    expect(
      measureAtomSelection([0, 0, 0, 1, 0, 0], [0, 1], minimumImage(singularCell)),
    ).toMatchObject({ ok: false, reason: "invalid-periodic-context" });
    expect(
      measureAtomSelection(
        [0, 0, 0, 1, 0, 0],
        [0, 1],
        minimumImage([1, 0, Number.NaN, 0, 1, 0, 0, 0, 1]),
      ),
    ).toMatchObject({ ok: false, reason: "invalid-periodic-context" });
  });

  it("rejects dependent or unsafe periodic bases without unbounded search", () => {
    const dependent = [
      1, 0, 0,
      2, 0, 0,
      0, 0, 0,
    ];
    expect(measureAtomSelection(
      [0, 0, 0, 0.2, 0, 0],
      [0, 1],
      minimumImage(dependent, [true, true, false]),
    )).toMatchObject({ ok: false, reason: "invalid-periodic-context" });

    const nearCollinear = [
      1, 0, 0,
      1, 2e-8, 0,
      0, 0, 1,
    ];
    expect(measureAtomSelection(
      [0, 0, 0, 0.123, 0.456, 0.789],
      [0, 1],
      minimumImage(nearCollinear),
    )).toMatchObject({ ok: false, reason: "invalid-periodic-context" });
  });
});
