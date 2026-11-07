import type { FontDefinition } from "@betteroffice/docx/utils";
import { loadFonts } from "../pptx/fonts";
import type { FontLoadProgress } from "../pptx/PresentationLoading";

// The document's families from the machine first (DE-18), read as the presentation editor reads
// them (pptx/fonts.ts: Local Font Access, Carlito/Caladea for Calibri/Cambria). The Word editor
// takes faces as URLs, so each face's bytes become a blob URL; families the machine lacks are left
// to the editor's own bundled stand-ins.

const STAND_INS = new Set(["calibri", "calibrilight", "cambria", "carlito", "caladea"]);

/** Faces for `families` as the Word editor's font definitions; `release` frees their URLs. */
export async function wordFonts(families: string[], progress: (value: FontLoadProgress) => void): Promise<{ fonts: FontDefinition[]; release: () => void }> {
  const faces = await loadFonts(families, progress);
  // The editor's definitions carry a weight, not a style: italics are drawn slanted from the upright face.
  // Not the bundled Calibri/Cambria stand-ins: once the editor has any face for a family it draws
  // that family's Chinese text with it too, as missing-glyph boxes, where with none it falls back to
  // the system's Chinese fonts (seen in the real app). Their metrics are a smaller gain than Chinese text.
  const upright = faces.filter((face) => !face.italic && !STAND_INS.has(face.family.toLowerCase().replace(/[\s_-]+/g, "")));
  const fonts = upright.map((face) => ({
    family: face.family,
    src: URL.createObjectURL(new Blob([face.bytes as Uint8Array<ArrayBuffer>], { type: "font/ttf" })),
    weight: face.bold ? 700 : 400,
  }));
  return { fonts, release: () => fonts.forEach((font) => URL.revokeObjectURL(font.src)) };
}
