import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DatasetChangedError,
  FrameCache,
  decodeFrame,
  getFrame,
  getInitialRecipe,
  getSelectedPositions,
  runRdfAnalysis,
} from "./api";

afterEach(() => vi.unstubAllGlobals());

function emptyFramePacket(): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify({ arrays: [] }));
  const packet = new Uint8Array(4 + header.length);
  new DataView(packet.buffer).setUint32(0, header.length, true);
  packet.set(header, 4);
  return packet.buffer;
}

function framePacket(byteLength: number): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify({
    arrays: [{
      name: "positions",
      dtype: "float32",
      shape: [byteLength / 4],
      byte_offset: 0,
      byte_length: byteLength,
    }],
  }));
  const packet = new Uint8Array(4 + header.length + byteLength);
  new DataView(packet.buffer).setUint32(0, header.length, true);
  packet.set(header, 4);
  return packet.buffer;
}

function integerFramePacket(): ArrayBuffer {
  const values = new Int32Array([1, -2, 3]);
  const header = new TextEncoder().encode(JSON.stringify({
    arrays: [{
      name: "centered_image_shifts",
      dtype: "int32",
      shape: [1, 3],
      byte_offset: 0,
      byte_length: values.byteLength,
    }],
  }));
  const packet = new Uint8Array(4 + header.length + values.byteLength);
  new DataView(packet.buffer).setUint32(0, header.length, true);
  packet.set(header, 4);
  packet.set(new Uint8Array(values.buffer), 4 + header.length);
  return packet.buffer;
}

describe("dataset generation", () => {
  it("loads the optional initial figure recipe", async () => {
    const recipe = { schema: "pqviewer.figure", schema_version: 1 };
    const fetch = vi.fn(() => Promise.resolve(Response.json(recipe)));
    vi.stubGlobal("fetch", fetch);

    await expect(getInitialRecipe()).resolves.toEqual(recipe);
    expect(fetch).toHaveBeenCalledWith(
      "/api/initial-recipe",
      { headers: { Accept: "application/json" } },
    );
  });

  it("encodes the generation when fetching a bound frame", async () => {
    const fetch = vi.fn((_input: string | URL | Request) => Promise.resolve(
      new Response(emptyFramePacket(), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetch);

    await getFrame(3, undefined, "run / α?");

    expect(String(fetch.mock.calls[0][0])).toBe(
      "/api/frames/3?dataset_generation=run%20%2F%20%CE%B1%3F",
    );
  });

  it("maps a stale generation response to DatasetChangedError", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(
      new Response(
        JSON.stringify({ detail: "Trajectory changed. Reload the manifest." }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    )));

    try {
      await getFrame(0, undefined, "stale");
      expect.fail("Expected the stale frame request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetChangedError);
      expect(error).toMatchObject({
        name: "DatasetChangedError",
        message: "Trajectory changed. Reload the manifest.",
      });
    }
  });

  it("requests deterministic unwrapped coordinates explicitly", async () => {
    const fetch = vi.fn((_input: string | URL | Request) => Promise.resolve(
      new Response(emptyFramePacket(), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetch);

    await getFrame(4, undefined, "run 8", "unwrapped");

    expect(String(fetch.mock.calls[0][0])).toBe(
      "/api/frames/4?dataset_generation=run%208&coordinates=unwrapped",
    );
  });
});

describe("frame decoding", () => {
  it("preserves exact integer image shifts", () => {
    const frame = decodeFrame(integerFramePacket());

    expect(frame.arrays.get("centered_image_shifts")).toEqual(
      new Int32Array([1, -2, 3]),
    );
  });
});

describe("compact scientific data", () => {
  it("loads selected unwrapped positions with stable frame keys", async () => {
    const fetch = vi.fn(() => Promise.resolve(Response.json({
      schema_version: 1,
      dataset_generation: "run-1",
      atom_indices: [0, 2],
      unit: "angstrom",
      frames: [{
        index: 4,
        key: {
          source_id: "segment-a",
          source_index: 4,
          segment_index: 0,
          step: 40,
          time: 2,
          time_unit: "ps",
        },
        positions: [[1, 2, 3], [4, 5, 6]],
        step: 40,
        time: 2,
        time_unit: "ps",
      }],
    })));
    vi.stubGlobal("fetch", fetch);

    const result = await getSelectedPositions({
      datasetGeneration: "run-1",
      atomIndices: [0, 2],
      frameIndices: [4],
    });

    expect(result.frames[0].positions).toEqual(
      new Float32Array([1, 2, 3, 4, 5, 6]),
    );
    expect(result.frames[0].key.source_index).toBe(4);
    const calls = fetch.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    const init = calls[0][1]!;
    expect(JSON.parse(String(init.body))).toEqual({
      dataset_generation: "run-1",
      atom_indices: [0, 2],
      frame_indices: [4],
      coordinates: "unwrapped",
    });
  });

  it("rejects malformed compact position alignment", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({
      schema_version: 1,
      dataset_generation: "run-1",
      atom_indices: [0],
      unit: "angstrom",
      frames: [{
        index: 3,
        key: {
          source_id: "segment-a",
          source_index: 3,
          segment_index: 0,
        },
        positions: [[1, 2]],
      }],
    }))));

    await expect(getSelectedPositions({
      datasetGeneration: "run-1",
      atomIndices: [0],
      frameIndices: [3],
    })).rejects.toThrow("coordinates are invalid");
  });

  it("parses one typed RDF and coordination result", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({
      schema_version: 1,
      dataset_generation: "run-2",
      selections: {
        reference_indices: [0, 1],
        target_indices: [2],
      },
      frame_range: {
        start: 0,
        stop: 3,
        step: 1,
        count: 3,
        first_key: {
          source_id: "segment-a",
          source_index: 0,
          segment_index: 0,
        },
        last_key: {
          source_id: "segment-a",
          source_index: 2,
          segment_index: 0,
        },
      },
      units: {
        radius: "angstrom",
        g_r: "dimensionless",
        coordination: "dimensionless",
      },
      parameters: {
        n_bins: 2,
        r_max: 2,
        delta_r: 1,
      },
      radius_centers: [0.5, 1.5],
      g_r: [0, 1.25],
      coordination_radius: [1, 2],
      coordination: [0, 1],
      pqanalysis_version: "1.4.0",
      elapsed_seconds: 0.02,
    }))));

    const result = await runRdfAnalysis({
      datasetGeneration: "run-2",
      referenceIndices: [0, 1],
      targetIndices: [2],
      bins: 2,
    });

    expect(result.radiusCenters).toEqual([0.5, 1.5]);
    expect(result.coordinationRadius).toEqual([1, 2]);
    expect(result.frameRange.lastKey.source_index).toBe(2);
  });

  it("maps stale scientific responses to DatasetChangedError", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json(
      { detail: "Trajectory changed." },
      { status: 409 },
    ))));

    await expect(getSelectedPositions({
      datasetGeneration: "old",
      atomIndices: [0],
      frameIndices: [0],
    })).rejects.toBeInstanceOf(DatasetChangedError);
    await expect(runRdfAnalysis({
      datasetGeneration: "old",
      referenceIndices: [0],
      targetIndices: [1],
    })).rejects.toBeInstanceOf(DatasetChangedError);
  });
});

describe("FrameCache", () => {
  it("binds current and prefetched frames to its dataset generation", async () => {
    const fetch = vi.fn((_input: string | URL | Request) => Promise.resolve(
      new Response(emptyFramePacket(), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetch);
    const cache = new FrameCache({ datasetGeneration: "dataset/42" });

    await cache.get(1);
    cache.prefetch(2, 3);
    await cache.get(2);

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/frames/1?dataset_generation=dataset%2F42",
      "/api/frames/2?dataset_generation=dataset%2F42",
    ]);
  });

  it("binds all cache requests to one coordinate mode", async () => {
    const fetch = vi.fn((_input: string | URL | Request) => Promise.resolve(
      new Response(emptyFramePacket(), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetch);
    const cache = new FrameCache({ coordinates: "unwrapped" });

    await cache.get(0);
    cache.prefetch(1, 2);
    await cache.get(1);

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/frames/0?coordinates=unwrapped",
      "/api/frames/1?coordinates=unwrapped",
    ]);
  });

  it("cancels obsolete pending frames while keeping the latest request", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/1")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }
      return Promise.resolve(new Response(emptyFramePacket(), { status: 200 }));
    }));

    const cache = new FrameCache();
    const obsolete = cache.get(1);
    const latest = cache.get(2);
    cache.cancelPendingExcept(2);

    await expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    await expect(latest).resolves.toMatchObject({ header: { arrays: [] } });
  });

  it("evicts least-recently-used frames at the frame limit", async () => {
    const fetch = vi.fn((_input: string | URL | Request) => Promise.resolve(
      new Response(emptyFramePacket(), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetch);
    const cache = new FrameCache({ maxFrames: 2 });

    await cache.get(1);
    await cache.get(2);
    await cache.get(1);
    await cache.get(3);
    await cache.get(1);
    await cache.get(2);

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/frames/1",
      "/api/frames/2",
      "/api/frames/3",
      "/api/frames/2",
    ]);
  });

  it("evicts resolved frames when decoded buffers exceed the byte budget", async () => {
    const fetch = vi.fn((_input: string | URL | Request) => Promise.resolve(
      new Response(framePacket(8), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetch);
    const cache = new FrameCache({ maxBytes: 12 });

    await cache.get(1);
    await cache.get(2);
    await cache.get(2);
    await cache.get(1);

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/frames/1",
      "/api/frames/2",
      "/api/frames/1",
    ]);
  });

  it("reduces pending prefetches to fit the decoded byte budget", async () => {
    const packet = framePacket(8);
    const pending: Array<(response: Response) => void> = [];
    const fetch = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetch);
    const cache = new FrameCache({ maxBytes: 16 });

    const current = cache.get(0);
    pending.shift()?.(new Response(packet, { status: 200 }));
    await current;

    cache.prefetch(1, 10);
    cache.prefetch(2, 10);
    cache.prefetch(3, 10);

    expect(fetch).toHaveBeenCalledTimes(2);
    pending.shift()?.(new Response(packet, { status: 200 }));

    await vi.waitFor(() => {
      cache.prefetch(2, 10);
      expect(fetch).toHaveBeenCalledTimes(3);
    });
    pending.shift()?.(new Response(packet, { status: 200 }));
    await cache.get(2);
  });

  it("does not prefetch frames larger than the byte budget", async () => {
    const fetch = vi.fn((_input: string | URL | Request) => Promise.resolve(
      new Response(framePacket(8), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetch);
    const cache = new FrameCache({ maxBytes: 4 });

    await cache.get(0);
    cache.prefetch(1, 10);
    await cache.get(0);

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/frames/0",
      "/api/frames/0",
    ]);
  });
});
