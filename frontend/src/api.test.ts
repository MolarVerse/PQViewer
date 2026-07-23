import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameCache } from "./api";

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

describe("FrameCache", () => {
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
