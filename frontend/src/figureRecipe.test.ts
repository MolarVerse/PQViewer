import { describe, expect, it } from "vitest";
import {
  cloneFigureRecipe,
  figureFrameFingerprint,
  figureSourceFromManifest,
  figureSourceIdentity,
  parseFigureRecipe,
  parseFigureRecipeJson,
  recipeMatchesManifestSource,
  sameFigureSource,
  sameFrameKey,
  stringifyFigureRecipe,
} from "./figureRecipe";
import type { FigureRecipe } from "./figureRecipe";
import type { Manifest } from "./types";

function completeRecipe(): FigureRecipe {
  return {
    schema: "pqviewer.figure",
    schema_version: 1,
    source: {
      kind: "pq-run-input",
      path: "/work/run.in",
      slice: { start: 2, stop: 20, step: 2 },
      segments: [{
        source_id: "/work/traj.xyz",
        kind: "pq-run-input",
        path: "/work/traj.xyz",
        input: "/work/run.in",
        frame_count: 9,
        files: {
          trajectory: "/work/traj.xyz",
          forces: "/work/run.force",
        },
      }],
    },
    frame: {
      index: 3,
      fingerprint: "frame-v1:0123456789abcdef",
      key: {
        source_id: "/work/traj.xyz",
        source_index: 8,
        segment_index: 0,
        step: 160,
        time: 80.5,
        time_unit: "fs",
      },
    },
    scene: {
      presentation: {
        mode: "ball-stick",
        water: "hide",
        hydrogens: false,
        wrap: "unwrapped",
        cellOrigin: [0.25, -0.5, 1.125],
        mirror: [true, false, true],
        images: { min: [-1, 0, -2], max: [1, 0, 2] },
        cell: true,
        bonds: true,
        forces: true,
        velocities: true,
        atomScale: 1.2,
        bondScale: 0.8,
        color: "residue",
        quality: "high",
      },
      selection: {
        atoms: [
          { atom: 8, image: [1, 0, -1] },
          { atom: 2, image: [0, 0, 0] },
        ],
        intent: "measurement",
        minimumImage: false,
      },
      vectors: {
        forceScale: 1.4,
        velocityScale: 0.6,
      },
    },
    camera: {
      position: [7.2, -3.1, 9.8],
      target: [0.2, 0.4, -0.5],
      up: [0, 1, 0],
      fov: 34,
      zoom: 1.1,
      near: 0.02,
      far: 5000,
    },
    output: {
      format: "tiff",
      width: 3600,
      height: 2400,
      dpi: 300,
      background: { kind: "solid", color: "#F6F8F8" },
      projection: "orthographic",
      fit: false,
      padding: 0.08,
      periodicContext: true,
    },
    annotations: [
      {
        kind: "atom-label",
        atom: { atom: 8, image: [1, 0, -1] },
        text: "O1",
        offset: [8, -6],
      },
      {
        kind: "legend",
        content: "forces",
        position: "top-right",
      },
      {
        kind: "scale-bar",
        length: 5,
        unit: "angstrom",
        position: "bottom-left",
      },
    ],
  };
}

describe("figure recipe parsing", () => {
  it("opens recipes saved before the bond layer was explicit", () => {
    const legacy = JSON.parse(JSON.stringify(completeRecipe())) as {
      scene: { presentation: Record<string, unknown> };
    };
    delete legacy.scene.presentation.bonds;

    expect(parseFigureRecipe(legacy).scene.presentation.bonds).toBe(true);
  });

  it("round-trips every scene, camera, output and annotation field", () => {
    const input = completeRecipe();
    const parsed = parseFigureRecipe(input);

    expect(parsed).toEqual({
      ...input,
      output: {
        ...input.output,
        background: { kind: "solid", color: "#f6f8f8" },
      },
    });
    expect(parseFigureRecipeJson(stringifyFigureRecipe(input))).toEqual(parsed);
  });

  it("round-trips crystal polyhedra", () => {
    const input = completeRecipe();
    input.scene.presentation.mode = "polyhedra";

    expect(parseFigureRecipe(input).scene.presentation.mode).toBe("polyhedra");
  });

  it("deep-clones ordered selections, periodic transforms and files", () => {
    const input = completeRecipe();
    const cloned = cloneFigureRecipe(input);

    input.scene.selection.atoms[0].image[0] = 4;
    input.scene.presentation.cellOrigin[0] = 7;
    input.source.segments[0].files!.forces = "/changed.force";
    input.annotations[0] = {
      kind: "legend",
      content: "elements",
      position: "top-left",
    };

    expect(cloned.scene.selection.atoms[0]).toEqual({ atom: 8, image: [1, 0, -1] });
    expect(cloned.scene.presentation.cellOrigin).toEqual([0.25, -0.5, 1.125]);
    expect(cloned.source.segments[0].files?.forces).toBe("/work/run.force");
    expect(cloned.annotations[0]).toMatchObject({ kind: "atom-label", text: "O1" });
  });

  it("writes stable JSON without rewriting paths", () => {
    const first = completeRecipe();
    first.source.path = String.raw`C:\runs\.\run.in`;
    first.source.segments[0].source_id = String.raw`C:\runs\traj.xyz`;
    first.source.segments[0].path = String.raw`C:\runs\traj.xyz`;
    first.frame.key.source_id = String.raw`C:\runs\traj.xyz`;
    first.source.segments[0].files = {
      trajectory: String.raw`C:\runs\traj.xyz`,
      charges: String.raw`C:\runs\run.chrg`,
      forces: String.raw`C:\runs\run.force`,
    };
    const second = cloneFigureRecipe(first);
    second.source.segments[0].files = {
      forces: String.raw`C:\runs\run.force`,
      trajectory: String.raw`C:\runs\traj.xyz`,
      charges: String.raw`C:\runs\run.chrg`,
    };

    expect(stringifyFigureRecipe(first)).toBe(stringifyFigureRecipe(second));
    expect(parseFigureRecipe(first).source.path).toBe(
      String.raw`C:\runs\.\run.in`,
    );
    expect(stringifyFigureRecipe(first)).toContain('"color": "#f6f8f8"');
  });

  it("preserves legal POSIX filenames containing a backslash", () => {
    const input = completeRecipe();
    const path = String.raw`/tmp/a\b.xyz`;
    input.source.path = path;
    input.source.segments[0].source_id = path;
    input.source.segments[0].path = path;
    input.source.segments[0].files = { trajectory: path };
    input.frame.key.source_id = path;

    const parsed = parseFigureRecipe(input);

    expect(parsed.source.path).toBe(path);
    expect(parsed.source.segments[0].path).toBe(path);
    expect(parsed.frame.key.source_id).toBe(path);
  });

  it("rejects invalid JSON, schemas, versions and unknown fields", () => {
    expect(() => parseFigureRecipeJson("{broken")).toThrow("not valid JSON");
    expect(() => parseFigureRecipe({ ...completeRecipe(), schema: "other" }))
      .toThrow("schema must be pqviewer.figure");
    expect(() => parseFigureRecipe({ ...completeRecipe(), schema_version: 2 }))
      .toThrow("Unsupported figure recipe version");
    expect(() => parseFigureRecipe({ ...completeRecipe(), extra: true }))
      .toThrow("unknown field: extra");
    expect(() => parseFigureRecipe({
      ...completeRecipe(),
      camera: { ...completeRecipe().camera, quaternion: [0, 0, 0, 1] },
    })).toThrow("unknown field: quaternion");
  });

  it("rejects malformed scientific state and non-finite camera values", () => {
    const fractionalImage = completeRecipe();
    fractionalImage.scene.selection.atoms[0].image[0] = 0.5;
    expect(() => parseFigureRecipe(fractionalImage)).toThrow("must be an integer");

    const zeroStep = completeRecipe();
    zeroStep.source.slice.step = 0;
    expect(() => parseFigureRecipe(zeroStep)).toThrow("step cannot be zero");

    const invalidCamera = completeRecipe();
    invalidCamera.camera.position[0] = Number.NaN;
    expect(() => parseFigureRecipe(invalidCamera)).toThrow("position[0] must be finite");

    const coincidentCamera = completeRecipe();
    coincidentCamera.camera.position = [...coincidentCamera.camera.target];
    expect(() => parseFigureRecipe(coincidentCamera)).toThrow("position must differ from target");

    const clippedCamera = completeRecipe();
    clippedCamera.camera.far = clippedCamera.camera.near;
    expect(() => parseFigureRecipe(clippedCamera)).toThrow("far must be greater than near");

    const parallelCamera = completeRecipe();
    parallelCamera.camera.up = parallelCamera.camera.target.map(
      (value, index) => value - parallelCamera.camera.position[index],
    ) as [number, number, number];
    expect(() => parseFigureRecipe(parallelCamera)).toThrow("up cannot be parallel");

    const reversedImages = completeRecipe();
    reversedImages.scene.presentation.images.min[0] = 2;
    expect(() => parseFigureRecipe(reversedImages)).toThrow("minimum cannot exceed");

    const duplicateSelection = completeRecipe();
    duplicateSelection.scene.selection.atoms.push({
      atom: 8,
      image: [1, 0, -1],
    });
    expect(() => parseFigureRecipe(duplicateSelection)).toThrow("duplicate atoms");

    const invalidFingerprint = completeRecipe();
    invalidFingerprint.frame.fingerprint = "changed";
    expect(() => parseFigureRecipe(invalidFingerprint)).toThrow(
      "fingerprint is invalid",
    );

    const missingFingerprint = completeRecipe() as unknown as {
      frame: Record<string, unknown>;
    };
    delete missingFingerprint.frame.fingerprint;
    expect(() => parseFigureRecipe(missingFingerprint)).toThrow(
      "fingerprint must be a non-empty string",
    );
  });

  it("requires the frame index and key to address the same sliced source frame", () => {
    const wrongIndex = completeRecipe();
    wrongIndex.frame.index = 2;
    expect(() => parseFigureRecipe(wrongIndex)).toThrow("does not match the sliced frame index");

    const wrongSegment = completeRecipe();
    wrongSegment.frame.key.segment_index = 1;
    expect(() => parseFigureRecipe(wrongSegment)).toThrow("segment is outside");

    const wrongSource = completeRecipe();
    wrongSource.frame.key.source_id = "/work/other.xyz";
    expect(() => parseFigureRecipe(wrongSource)).toThrow("source_id does not match");

    const outsideSlice = completeRecipe();
    outsideSlice.frame.index = 4;
    expect(() => parseFigureRecipe(outsideSlice)).toThrow("index is outside the source slice");
  });

  it("rejects invalid output and annotations", () => {
    const transparentColor = completeRecipe();
    transparentColor.output.background = {
      kind: "transparent",
      color: "#ffffff",
    } as FigureRecipe["output"]["background"];
    expect(() => parseFigureRecipe(transparentColor)).toThrow("unknown field: color");

    const badColor = completeRecipe();
    badColor.output.background = { kind: "solid", color: "white" };
    expect(() => parseFigureRecipe(badColor)).toThrow("must use #RRGGBB");

    const badPadding = completeRecipe();
    badPadding.output.padding = 0.5;
    expect(() => parseFigureRecipe(badPadding)).toThrow("between 0 and 0.4");

    const badScale = completeRecipe();
    badScale.annotations[2] = {
      kind: "scale-bar",
      length: 0,
      unit: "angstrom",
      position: "bottom-left",
    };
    expect(() => parseFigureRecipe(badScale)).toThrow("length must be positive");

    const blankLabel = completeRecipe();
    blankLabel.annotations[0] = {
      kind: "atom-label",
      atom: { atom: 1, image: [0, 0, 0] },
      text: " ",
    };
    expect(() => parseFigureRecipe(blankLabel)).toThrow("text must be a non-empty string");
  });
});

describe("figure frame fingerprint", () => {
  it("matches the backend contract and changes with source frame data", () => {
    const manifest = {
      schema_version: 2,
      name: "water.xyz",
      frame_count: 1,
      topology: {
        atom_count: 2,
        atomic_numbers: [8, 1],
        bonds: [[0, 1]] as [number, number][],
      },
    };
    const header = {
      arrays: [
        {
          name: "positions",
          dtype: "float32",
          byte_order: "little",
          shape: [2, 3],
          byte_offset: 0,
          byte_length: 24,
          unit: null,
        },
        {
          name: "cell",
          dtype: "float32",
          byte_order: "little",
          shape: [3, 3],
          byte_offset: 24,
          byte_length: 36,
          unit: null,
        },
      ],
      pbc: [true, true, true],
    };
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    const cell = new Float32Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]);
    const first = {
      header,
      arrays: new Map<string, Float32Array | Int32Array>([
        ["positions", positions],
        ["cell", cell],
      ]),
    };
    const reordered = {
      header,
      arrays: new Map<string, Float32Array | Int32Array>([
        ["cell", cell.slice()],
        ["positions", positions.slice()],
      ]),
    };
    const changed = {
      header,
      arrays: new Map<string, Float32Array | Int32Array>([
        ["positions", new Float32Array([0, 0, 0, 1.1, 0, 0])],
        ["cell", cell],
      ]),
    };

    expect(figureFrameFingerprint(manifest, first)).toBe(
      "frame-v1:8881a14a54d2137a",
    );
    expect(figureFrameFingerprint(manifest, reordered)).toBe(
      figureFrameFingerprint(manifest, first),
    );
    expect(figureFrameFingerprint(manifest, changed)).not.toBe(
      figureFrameFingerprint(manifest, first),
    );
    const unwrapped = {
      header: {
        ...header,
        coordinates: "unwrapped",
        arrays: [
          ...header.arrays,
          {
            name: "unwrapped_positions",
            dtype: "float32",
            byte_order: "little",
            shape: [2, 3],
            byte_offset: 60,
            byte_length: 24,
            unit: null,
          },
          {
            name: "unwrapped_image_shifts",
            dtype: "int32",
            byte_order: "little",
            shape: [2, 3],
            byte_offset: 84,
            byte_length: 24,
            unit: null,
          },
        ],
      },
      arrays: new Map<string, Float32Array | Int32Array>([
        ["positions", positions],
        ["cell", cell],
        ["unwrapped_positions", new Float32Array([0, 0, 0, 2, 0, 0])],
        ["unwrapped_image_shifts", new Int32Array([0, 0, 0, 1, 0, 0])],
      ]),
    };
    expect(figureFrameFingerprint(manifest, unwrapped)).toBe(
      "frame-v1:b7d697621223d33d",
    );
  });

  it("uses derived periodic arrays only for unwrapped coordinates", () => {
    const manifest = {
      schema_version: 2,
      name: "periodic.xyz",
      frame_count: 1,
      topology: { atom_count: 1, atomic_numbers: [1], bonds: [] },
    };
    const source = {
      header: {
        arrays: [{
          name: "positions",
          dtype: "float32",
          byte_order: "little",
          shape: [1, 3],
          byte_offset: 0,
          byte_length: 12,
          unit: null,
        }],
        coordinates: "source",
        pbc: [true, true, true],
      },
      arrays: new Map([["positions", new Float32Array([0, 0, 0])]]),
    };
    const derived = {
      header: {
        ...source.header,
        arrays: [
          ...source.header.arrays,
          {
            name: "unwrapped_positions",
            dtype: "float32",
            byte_order: "little",
            shape: [1, 3],
            byte_offset: 12,
            byte_length: 12,
            unit: null,
          },
          {
            name: "centered_image_shifts",
            dtype: "int32",
            byte_order: "little",
            shape: [1, 3],
            byte_offset: 24,
            byte_length: 12,
            unit: null,
          },
        ],
      },
      arrays: new Map<string, Float32Array | Int32Array>([
        ...source.arrays,
        ["unwrapped_positions", new Float32Array([9, 0, 0])],
        ["centered_image_shifts", new Int32Array([1, 0, 0])],
      ]),
    };

    expect(figureFrameFingerprint(manifest, derived)).toBe(
      figureFrameFingerprint(manifest, source),
    );
    const unwrapped = {
      ...derived,
      header: { ...derived.header, coordinates: "unwrapped" },
    };
    const changedUnwrapped = {
      ...unwrapped,
      arrays: new Map<string, Float32Array | Int32Array>([
        ["positions", new Float32Array([0, 0, 0])],
        ["unwrapped_positions", new Float32Array([10, 0, 0])],
        ["centered_image_shifts", new Int32Array([1, 0, 0])],
      ]),
    };
    expect(figureFrameFingerprint(manifest, unwrapped)).not.toBe(
      figureFrameFingerprint(manifest, source),
    );
    expect(figureFrameFingerprint(manifest, changedUnwrapped)).not.toBe(
      figureFrameFingerprint(manifest, unwrapped),
    );
  });
});

describe("figure source identity", () => {
  it("matches the same source across file ordering and growing frame counts", () => {
    const first = completeRecipe().source;
    const second = completeRecipe().source;
    second.segments[0].frame_count = 100;
    second.segments[0].files = {
      forces: "/work/run.force",
      trajectory: "/work/traj.xyz",
    };

    expect(figureSourceIdentity(first)).toBe(figureSourceIdentity(second));
    expect(sameFigureSource(first, second)).toBe(true);
  });

  it("distinguishes slices, entry points and companion files", () => {
    const source = completeRecipe().source;
    expect(sameFigureSource(source, {
      ...source,
      slice: { ...source.slice, step: 1 },
    })).toBe(false);
    expect(sameFigureSource(source, {
      ...source,
      path: "/work/other.in",
    })).toBe(false);
    expect(sameFigureSource(source, {
      ...source,
      segments: [{
        ...source.segments[0],
        files: {
          ...source.segments[0].files,
          forces: "/work/other.force",
        },
      }],
    })).toBe(false);
  });

  it("extracts and matches a durable manifest source", () => {
    const recipe = completeRecipe();
    const manifest = {
      schema_version: 1,
      name: "run",
      frame_count: 9,
      topology: { atom_count: 10 },
      source: recipe.source,
    } satisfies Manifest;

    expect(figureSourceFromManifest(manifest)).toEqual(recipe.source);
    expect(recipeMatchesManifestSource(recipe, manifest)).toBe(true);
    expect(recipeMatchesManifestSource(recipe, {
      ...manifest,
      source: { ...recipe.source, path: "/work/other.in" },
    })).toBe(false);
  });

  it("rejects missing and non-durable sources", () => {
    const manifest = {
      schema_version: 1,
      name: "ASE Atoms",
      frame_count: 1,
      topology: { atom_count: 1 },
    } satisfies Manifest;
    expect(() => figureSourceFromManifest(manifest)).toThrow("no source information");
    expect(() => figureSourceFromManifest({
      ...manifest,
      source: {
        kind: "ase-object",
        segments: [{
          source_id: "ase:Atoms",
          kind: "ase-object",
          frame_count: 1,
        }],
      },
    })).toThrow("source path");
  });
});

describe("figure frame identity", () => {
  it("matches complete frame keys and normalizes omitted metadata to null", () => {
    const key = completeRecipe().frame.key;
    expect(sameFrameKey(key, { ...key })).toBe(true);
    expect(sameFrameKey({
      source_id: "segment",
      source_index: 3,
      segment_index: 1,
    }, {
      source_id: "segment",
      source_index: 3,
      segment_index: 1,
      step: null,
      time: null,
      time_unit: null,
    })).toBe(true);
  });

  it("rejects changed segment, source index, step or time", () => {
    const key = completeRecipe().frame.key;
    expect(sameFrameKey(key, { ...key, segment_index: 1 })).toBe(false);
    expect(sameFrameKey(key, { ...key, source_index: 9 })).toBe(false);
    expect(sameFrameKey(key, { ...key, step: 161 })).toBe(false);
    expect(sameFrameKey(key, { ...key, time: 80.5001 })).toBe(false);
    expect(sameFrameKey(key, null)).toBe(false);
  });
});
