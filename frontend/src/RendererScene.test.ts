import { describe, expect, it } from "vitest";
import { resolveRendererEngine } from "./RendererScene";

describe("renderer selection", () => {
  it("uses the bundled 3Dmol engine by default", () => {
    expect(resolveRendererEngine("")).toBe("3dmol");
    expect(resolveRendererEngine("?renderer=3dmol")).toBe("3dmol");
  });

  it("keeps the previous renderer as an explicit fallback", () => {
    expect(resolveRendererEngine("?renderer=three")).toBe("three");
    expect(resolveRendererEngine("?renderer=other")).toBe("3dmol");
  });
});
