import { describe, expect, it, vi } from "vitest";
import {
  loadPublicationFont,
  publicationFontDeclaration,
} from "./publicationFont";

describe("publication font", () => {
  it("uses the bundled Inter face", () => {
    expect(publicationFontDeclaration(18)).toBe('600 18px "Inter"');
  });

  it("waits for the requested annotation glyphs", async () => {
    const load = vi.fn(async () => [{} as FontFace]);
    const check = vi.fn(() => true);

    await expect(loadPublicationFont(
      18,
      "Carbon Å",
      { load, check } as Pick<FontFaceSet, "load" | "check">,
    )).resolves.toBe('600 18px "Inter"');
    expect(load).toHaveBeenCalledWith('600 18px "Inter"', "Carbon Å");
    expect(check).toHaveBeenCalledWith('600 18px "Inter"', "Carbon Å");
  });

  it("fails instead of falling back to a system font", async () => {
    const load = vi.fn(async () => [] as FontFace[]);
    const check = vi.fn(() => false);

    await expect(loadPublicationFont(
      18,
      "H2O",
      { load, check } as Pick<FontFaceSet, "load" | "check">,
    )).rejects.toThrow("Publication font is unavailable");
  });
});
