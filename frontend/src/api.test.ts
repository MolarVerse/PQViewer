import { afterEach, describe, expect, it, vi } from "vitest";
import { DatasetChangedError, FrameCache, getFrame } from "./api";

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

describe("dataset generation", () => {
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
