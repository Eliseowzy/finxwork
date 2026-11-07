import type { PptxFontFace } from "@betteroffice/pptx";
import type { FontLoadProgress } from "./PresentationLoading";

// Fonts come straight from the machine through the Local Font Access API
// (`queryLocalFonts`); no font CDN or kernel round trip. Only the metric-compatible stand-ins
// for Calibri and Cambria (Carlito, Caladea, from @betteroffice/fonts) are bundled, so a deck
// breaks its lines as PowerPoint does on a machine without Office's fonts.

/** One installed family the editor can draw. */
export interface PptxFontFamily {
  /** The English (or only) name, stored in the slide. */
  family: string;
  /** The Chinese name, when the font has one. */
  localized?: string | null;
  /** Set when the machine lacks the family and a bundled metric-compatible face (this name) is drawn in its place. */
  substitute?: string;
}

/** The families the app can draw without the machine having them: the Office name -> the bundled family and its files. */
const BUNDLED: Record<string, { family: string; files: string; displayAs: string }> = {
  calibri: { family: "Carlito", files: "Carlito", displayAs: "Calibri" },
  "calibrilight": { family: "Carlito", files: "Carlito", displayAs: "Calibri Light" },
  cambria: { family: "Caladea", files: "Caladea", displayAs: "Cambria" },
  carlito: { family: "Carlito", files: "Carlito", displayAs: "Carlito" },
  caladea: { family: "Caladea", files: "Caladea", displayAs: "Caladea" },
};
/** Listed in the font menu when the machine lacks them. */
const LISTED_STAND_INS = ["calibri", "calibrilight", "cambria"];

function bundledFile(family: string, bold: boolean, italic: boolean): string | undefined {
  const entry = BUNDLED[fold(family)];
  return entry && `${entry.files}-${bold ? (italic ? "BoldItalic" : "Bold") : (italic ? "Italic" : "Regular")}.ttf`;
}

type BundledLoader = (file: string) => Promise<Uint8Array>;
// electron.vite.config.ts serves/emits the files at fonts/ beside the page (dev middleware, build asset).
let bundledLoader: BundledLoader = async (file) => {
  if (typeof document === "undefined") throw new Error("bundled fonts need a page");
  const response = await fetch(new URL(`fonts/${file}`, document.baseURI));
  if (!response.ok) throw new Error(`bundled font ${file}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};
/** Tests swap the bundled font source for a fake. */
export function setBundledFontLoader(next: BundledLoader) { bundledLoader = next; faceCache.clear(); }

/** The BetterOffice engine refuses faces above this size (`invalid-payload`; raised from 32 MiB in our patch). */
export const MAX_FACE_BYTES = 64 * 1024 * 1024;

interface LocalFont { family: string; fullName: string; style: string; postscriptName: string; blob(): Promise<Blob> }
type FontQuery = () => Promise<LocalFont[]>;

export const isCjk = (family: string) => /[㐀-鿿]|pingfang|hiragino|cjk|source han|noto.*sc|dengxian|yahei|simsun|simhei|fangsong|kaiti|heiti|songti|stsong|stheiti/i.test(family);
const hasCjk = (text: string) => /[㐀-鿿]/.test(text);
const fold = (text: string) => text.toLocaleLowerCase().replace(/[\s_-]+/g, "");

const BOLD = /bold|heavy|black|semibold|demibold|粗/i;
const ITALIC = /italic|oblique|斜/i;
const STYLE_WORD = /\s+(regular|normal|book|roman|medium|light|thin|bold|italic|oblique|semibold|demibold|heavy|black|w\d|常规体?|标准体?|粗体|细体|中等|斜体|中粗体?)(\s.*)?$/i;

let query: FontQuery = () => (globalThis as unknown as { queryLocalFonts?: FontQuery }).queryLocalFonts?.() ?? Promise.reject(new Error("queryLocalFonts unavailable"));
/** Tests swap the system query for a fake. */
export function setFontQuery(next: FontQuery) { query = next; catalog = null; faceCache.clear(); }

interface Family { family: string; localized: string | null; faces: LocalFont[] }
let catalog: Promise<Map<string, Family>> | null = null;

/** Every installed family, keyed by both its English and Chinese name (folded). */
function families(): Promise<Map<string, Family>> {
  if (catalog) return catalog;
  catalog = query().then((all) => {
    const byFamily = new Map<string, Family>();
    for (const font of all) {
      if (!font.family || font.family.startsWith(".")) continue;
      let entry = byFamily.get(font.family);
      if (!entry) byFamily.set(font.family, entry = { family: font.family, localized: null, faces: [] });
      entry.faces.push(font);
    }
    const index = new Map<string, Family>();
    for (const entry of byFamily.values()) {
      const named = entry.faces.find((f) => hasCjk(f.fullName) && !BOLD.test(f.style)) ?? entry.faces.find((f) => hasCjk(f.fullName));
      if (named) entry.localized = named.fullName.replace(STYLE_WORD, "").trim() || named.fullName;
      index.set(fold(entry.family), entry);
      if (entry.localized && !index.has(fold(entry.localized))) index.set(fold(entry.localized), entry);
    }
    return index;
  });
  void catalog.catch(() => { catalog = null; });
  return catalog;
}

/** The machine's families for the font menu. */
export async function listFonts(): Promise<PptxFontFamily[]> {
  const seen = new Set<Family>();
  const index = await families();
  for (const entry of index.values()) seen.add(entry);
  const list: PptxFontFamily[] = [...seen].map(({ family, localized }) => ({ family, localized }));
  for (const key of LISTED_STAND_INS) {
    if (!index.has(key)) list.push({ family: BUNDLED[key]!.displayAs, substitute: BUNDLED[key]!.family });
  }
  return list.sort((a, b) => a.family.toLowerCase().localeCompare(b.family.toLowerCase()));
}

/** The face closest to the wanted style; an exact bold/italic match is required. */
function pick(faces: LocalFont[], bold: boolean, italic: boolean): LocalFont | undefined {
  const matching = faces.filter((f) => BOLD.test(f.style) === bold && ITALIC.test(f.style) === italic);
  const plain = (f: LocalFont) => /^(regular|normal|book|roman|常规体?|标准体?)$/i.test(f.style.trim()) ? 0
    : /^(bold|粗体)$/i.test(f.style.trim()) ? 0 : /medium|中等/i.test(f.style) ? 1 : 2;
  return matching.sort((a, b) => plain(a) - plain(b))[0];
}

const faceCache = new Map<string, Promise<Uint8Array>>();
/** `cjk` lists families known to be CJK beyond the name heuristic, e.g. from their Chinese name. */
export async function loadFonts(families_: string[], progress: (value: FontLoadProgress) => void, cjkFamilies?: ReadonlySet<string>): Promise<PptxFontFace[]> {
  const fonts: PptxFontFace[] = [];
  let index: Map<string, Family>;
  try { index = await families(); } catch (error) {
    console.warn("pptx fonts unavailable", error);
    progress({ completed: 0, total: 0 });
    return fonts;
  }
  let completed = 0;
  const cjkFamily = (family: string) => isCjk(family) || !!cjkFamilies?.has(family) || !!index.get(fold(family))?.localized;
  const total = families_.reduce((count, family) => count + (cjkFamily(family) ? 2 : 4), 0);
  progress({ completed: 0, total });
  // Sequential: a CJK face can be tens of MiB, and each is read only when needed.
  for (const family of families_) {
    const entry = index.get(fold(family));
    const cjk = cjkFamily(family);
    for (const bold of [false, true]) for (const italic of cjk ? [false] : [false, true]) {
      progress({ completed, total, family, bold, italic });
      const face = entry && pick(entry.faces, bold, italic);
      const file = entry ? undefined : bundledFile(family, bold, italic);
      if (file) {
        // Registered under the document's own name ("Calibri"), so the deck keeps it.
        try {
          let promise = faceCache.get(file);
          if (!promise) {
            promise = bundledLoader(file);
            faceCache.set(file, promise);
            void promise.finally(() => faceCache.delete(file)).catch(() => {});
          }
          fonts.push({ family, bold, italic, bytes: await promise });
        } catch (error) {
          console.warn(`pptx bundled font unavailable: ${family} bold=${bold} italic=${italic}`, error);
        }
      } else if (face) {
        const key = face.postscriptName || `${face.family}/${face.style}`;
        let promise = faceCache.get(key);
        if (!promise) {
          promise = face.blob().then(async (blob) => {
            if (blob.size > MAX_FACE_BYTES) throw new Error(`font face exceeds 64 MiB (${blob.size} bytes)`);
            return new Uint8Array(await blob.arrayBuffer());
          });
          faceCache.set(key, promise);
          // Only shared while in flight: the engine keeps the bytes, so no second copy stays here.
          void promise.finally(() => faceCache.delete(key)).catch(() => {});
        }
        // A face that cannot be read is skipped; the engine substitutes it.
        try {
          // Registered under the document's own name, so its runs find the face.
          fonts.push({ family, bold, italic, bytes: await promise });
        } catch (error) {
          console.warn(`pptx font unavailable: ${family} bold=${bold} italic=${italic}`, error);
        }
      }
      completed += 1;
      progress({ completed, total, family, bold, italic });
    }
  }
  return fonts;
}

/** Reads one face's bytes, sharing a read already in flight. */
function readShared(key: string, read: () => Promise<Uint8Array>): Promise<Uint8Array> {
  let promise = faceCache.get(key);
  if (!promise) {
    promise = read();
    faceCache.set(key, promise);
    void promise.finally(() => faceCache.delete(key)).catch(() => {});
  }
  return promise;
}

/** A face the machine (or the bundled stand-ins) can supply, read only when called. */
export type FaceReader = (() => Promise<Uint8Array>) & { family: string; bold: boolean; italic: boolean; standIn: boolean };

/**
 * The machine's faces looked up without reading them, for editors that load faces as they need them
 * (the Word editor's font provider). `face` answers synchronously once the catalog is read: the
 * installed family first, else the bundled Calibri/Cambria stand-in; `exact` refuses another style.
 */
export async function faceCatalog(): Promise<{ face(family: string, bold: boolean, italic: boolean, exact?: boolean): FaceReader | undefined }> {
  let index: Map<string, Family>;
  try { index = await families(); } catch (error) {
    console.warn("system fonts unavailable", error);
    index = new Map();
  }
  return {
    face(family, bold, italic, exact = false) {
      const entry = index.get(fold(family));
      if (entry) {
        const face = pick(entry.faces, bold, italic) ?? (exact ? undefined : pick(entry.faces, bold, false) ?? pick(entry.faces, false, false) ?? entry.faces[0]);
        if (!face) return undefined;
        const read = () => readShared(face.postscriptName || `${face.family}/${face.style}`, () => face.blob().then(async (blob) => {
          if (blob.size > MAX_FACE_BYTES) throw new Error(`font face exceeds 64 MiB (${blob.size} bytes)`);
          return new Uint8Array(await blob.arrayBuffer());
        }));
        return Object.assign(read, { family: entry.family, bold: BOLD.test(face.style), italic: ITALIC.test(face.style), standIn: false });
      }
      const file = bundledFile(family, bold, italic);
      if (!file) return undefined;
      return Object.assign(() => readShared(file, () => bundledLoader(file)), { family: BUNDLED[fold(family)]!.family, bold, italic, standIn: true });
    },
  };
}
