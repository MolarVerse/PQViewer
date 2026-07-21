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
});
