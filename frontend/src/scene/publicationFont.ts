export const PUBLICATION_FONT_FAMILY = "Inter";
export const PUBLICATION_FONT_WEIGHT = 600;

type PublicationFontSet = Pick<FontFaceSet, "check" | "load">;

export function publicationFontDeclaration(fontSize: number): string {
  return `${PUBLICATION_FONT_WEIGHT} ${fontSize}px "${PUBLICATION_FONT_FAMILY}"`;
}

export async function loadPublicationFont(
  fontSize: number,
  sample: string,
  fontSet: PublicationFontSet | undefined = (
    typeof document === "undefined" ? undefined : document.fonts
  ),
): Promise<string> {
  if (!fontSet) throw new Error("Publication font is unavailable");
  const declaration = publicationFontDeclaration(fontSize);
  const text = sample.trim() || "PQ";
  try {
    const loaded = await fontSet.load(declaration, text);
    if (loaded.length === 0 || !fontSet.check(declaration, text)) {
      throw new Error("font did not load");
    }
  } catch {
    throw new Error("Publication font is unavailable");
  }
  return declaration;
}
