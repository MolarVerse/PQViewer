import { describe, expect, it } from "vitest";
import { resolveRendererEngine } from "./RendererScene";

describe("renderer selection", () => {
  it("uses the bundled 3Dmol engine for interactive viewing", () => {
    expect(resolveRendererEngine("")).toBe("3dmol");
    expect(resolveRendererEngine("?renderer=3dmol")).toBe("3dmol");
  });

  it("does not offer a second interactive engine through the URL", () => {
    expect(resolveRendererEngine("?renderer=three")).toBe("3dmol");
    expect(resolveRendererEngine("?renderer=other")).toBe("3dmol");
  });
});
