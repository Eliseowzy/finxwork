import type { BundledFontProvider, FontScript } from "@nimbleoffice/docx/layout";
import { faceCatalog, type FaceReader } from "../pptx/fonts.ts";

// The Word engine measures and paints every glyph from font bytes it is given (glyph outlines on a
// canvas, not the browser's text), so it needs a font provider: without one it measures with
// synthetic metrics. This one answers from the machine (DE-18, read as pptx/fonts.ts reads it),
// lazily, face by face:
// - a family the document names: the installed family, else Carlito/Caladea measured as Calibri/Cambria;
// - Windows Chinese families (宋体, 黑体, 微软雅黑 …): macOS's own Chinese faces;
// - Chinese (and other CJK) text whose family lacks the glyphs: the system's CJK faces, as the
//   script and per-family coverage fallbacks, so it never draws as missing-glyph boxes;
// - any other family: Arial / Times New Roman, as Word substitutes, only when nothing else loads.
//
// The faces are not handed over as the editor's `fonts` (app-hosted faces): for a hosted family the
// engine leaves out the provider's coverage fallbacks (@nimbleoffice/docx 0.5.1,
// layout/measure/defaultFontProvider.ts excludeHostedFontFamilies, and rustMeasureSource.ts, which
// skips script fallbacks for hosted families), so a hosted "Calibri" drew Chinese as boxes.

/** Windows (and Office) families a Mac lacks -> the installed families drawn in their place, in order. */
export const SYSTEM_ALIASES: Record<string, string[]> = {
  simsun: ["Songti SC", "STSong"], 宋体: ["Songti SC", "STSong"], nsimsun: ["Songti SC", "STSong"], 新宋体: ["Songti SC", "STSong"],
  simhei: ["Heiti SC", "STHeiti", "PingFang SC"], 黑体: ["Heiti SC", "STHeiti", "PingFang SC"],
  microsoftyahei: ["PingFang SC", "Hiragino Sans GB"], 微软雅黑: ["PingFang SC", "Hiragino Sans GB"],
  microsoftyaheiui: ["PingFang SC", "Hiragino Sans GB"], dengxian: ["PingFang SC", "Hiragino Sans GB"], 等线: ["PingFang SC", "Hiragino Sans GB"],
  dengxianlight: ["PingFang SC", "Hiragino Sans GB"], 等线light: ["PingFang SC", "Hiragino Sans GB"],
  kaiti: ["Kaiti SC", "STKaiti"], 楷体: ["Kaiti SC", "STKaiti"], kaitigb2312: ["Kaiti SC", "STKaiti"], 楷体gb2312: ["Kaiti SC", "STKaiti"],
  fangsong: ["STFangsong"], 仿宋: ["STFangsong"], fangsonggb2312: ["STFangsong"], 仿宋gb2312: ["STFangsong"],
  mingliu: ["PingFang TC", "Songti TC"], pmingliu: ["PingFang TC", "Songti TC"], 新細明體: ["PingFang TC", "Songti TC"], microsoftjhenghei: ["PingFang TC"],
  msmincho: ["Hiragino Mincho ProN"], "ｍｓ明朝": ["Hiragino Mincho ProN"], msgothic: ["Hiragino Sans"], "ｍｓゴシック": ["Hiragino Sans"],
  yumincho: ["Hiragino Mincho ProN"], yugothic: ["Hiragino Sans"], meiryo: ["Hiragino Sans"],
  malgungothic: ["Apple SD Gothic Neo"], batang: ["AppleMyungjo"], gulim: ["Apple SD Gothic Neo"],
};

const SANS_CJK: Record<FontScript, string[]> = {
  "cjk-sc": ["PingFang SC", "Hiragino Sans GB", "STHeiti", "Heiti SC"],
  "cjk-tc": ["PingFang TC", "Heiti TC", "PingFang SC"],
  "cjk-jp": ["Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang SC"],
  "cjk-kr": ["Apple SD Gothic Neo", "AppleGothic"],
  arabic: ["Geeza Pro", "Arial"],
  hebrew: ["Arial Hebrew", "Arial"],
};
const SERIF_SC = ["Songti SC", "STSong", "PingFang SC"];

const fold = (text: string) => text.toLocaleLowerCase().replace(/[\s_-]+/g, "");
/** Serif families, whose Chinese reads best in a Song face. */
const SERIF = /song|宋|mincho|明|ming|serif|times|cambria|caladea|georgia|garamond|book|roman|batang|仿宋|fangsong/i;

type BundledFontLoader = NonNullable<ReturnType<BundledFontProvider["resolve"]>>;
type Catalog = Awaited<ReturnType<typeof faceCatalog>>;

function loader(face: FaceReader, measureAs?: string, onlyIfPrimaryFails = false): BundledFontLoader {
  const load = async () => {
    const bytes = await face();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };
  return Object.assign(load, measureAs ? { measureAs } : {}, onlyIfPrimaryFails ? { onlyIfPrimaryFails } : {});
}

/** The first of `families` the machine has. */
function first(catalog: Catalog, families: string[], bold: boolean, italic: boolean): FaceReader | undefined {
  for (const family of families) {
    const face = catalog.face(family, bold, italic);
    if (face && !face.standIn) return face;
  }
  return undefined;
}

/** The Word engine's font provider over `catalog` (exported for tests; the app uses {@link wordFontProvider}). */
export function providerFor(catalog: Catalog): BundledFontProvider {
  const resolve = (family: string, bold: boolean, italic: boolean): BundledFontLoader | undefined => {
    const face = catalog.face(family, bold, italic);
    // A stand-in measures as the family it stands in for (Carlito as Calibri), so lines break as in Word.
    if (face) return loader(face, face.standIn ? family : undefined);
    const alias = SYSTEM_ALIASES[fold(family)];
    const aliased = alias && first(catalog, alias, bold, italic);
    return aliased ? loader(aliased) : undefined;
  };
  return {
    resolve,
    resolveFamily: resolve,
    resolveScriptFallback(script, bold) {
      const face = first(catalog, SANS_CJK[script] ?? [], bold, false);
      return face && loader(face);
    },
    resolveGlyphFallback(family, bold) {
      // Chinese text in a family without it (Calibri, Times New Roman): drawn in the system's Chinese face.
      const face = first(catalog, SERIF.test(family) ? SERIF_SC : SANS_CJK["cjk-sc"], bold, false);
      return face && loader(face);
    },
    resolveLastResort(family, bold, italic) {
      const face = first(catalog, SERIF.test(family) ? ["Times New Roman", "Times"] : ["Arial", "Helvetica"], bold, italic);
      return face && loader(face, undefined, true);
    },
  };
}

let shared: Promise<BundledFontProvider> | null = null;
/** The app's one Word font provider (the engine keeps a registry's provider, so it is not per document). */
export function wordFontProvider(): Promise<BundledFontProvider> {
  shared ??= faceCatalog().then(providerFor);
  void shared.catch(() => { shared = null; });
  return shared;
}
