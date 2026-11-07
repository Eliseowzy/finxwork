import type { FontDefinition } from "@betteroffice/docx/utils";
import { loadFonts } from "../pptx/fonts";
import type { FontLoadProgress } from "../pptx/PresentationLoading";

// The document's families from the machine first (DE-18), read as the presentation editor reads
// them (pptx/fonts.ts: Local Font Access, Carlito/Caladea for Calibri/Cambria). The Word editor
// takes faces as URLs, so each face's bytes become a blob URL; families the machine lacks are left
// to the editor's own bundled stand-ins.

/** Faces for `families` as the Word editor's font definitions; `release` frees their URLs. */
export async function wordFonts(families: string[], progress: (value: FontLoadProgress) => void): Promise<{ fonts: FontDefinition[]; release: () => void }> {
  const faces = await loadFonts(families, progress);
  // The editor's definitions carry a weight, not a style: italics are drawn slanted from the upright face.
  const upright = faces.filter((face) => !face.italic);
  const fonts = upright.map((face) => ({
    family: face.family,
    src: URL.createObjectURL(new Blob([face.bytes as Uint8Array<ArrayBuffer>], { type: "font/ttf" })),
    weight: face.bold ? 700 : 400,
  }));
  return { fonts, release: () => fonts.forEach((font) => URL.revokeObjectURL(font.src)) };
}
