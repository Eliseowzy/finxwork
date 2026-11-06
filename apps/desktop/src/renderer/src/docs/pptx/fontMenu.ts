import type { PptxFontFamily } from "./fonts";

export interface FontEntry {
  /** Stored in the slide and used to fetch faces. */
  family: string;
  /** What the menu shows: the Chinese name in a Chinese UI, else the family. */
  label: string;
  /** Whether the family has a Chinese name, so it loads no italic faces. */
  cjk: boolean;
  /** The bundled family drawn instead, when the machine lacks this one. */
  substitute?: string;
}

export interface FontMenu {
  /** Families this presentation already uses, in its order. */
  document: FontEntry[];
  /** Every installed family; in a Chinese UI those with Chinese names come first. */
  all: FontEntry[];
}

const fold = (text: string) => text.toLocaleLowerCase().replace(/\s+/g, "");

/** The font menu's two sections, filtered by `query` against both names. */
export function fontMenu(installed: readonly PptxFontFamily[], documentFamilies: readonly string[], language: string, query = ""): FontMenu {
  const chinese = language.startsWith("zh");
  const byName = new Map(installed.map((f) => [f.family.toLowerCase(), f]));
  const entry = (family: string, localized?: string | null, substitute?: string): FontEntry =>
    ({ family, label: chinese && localized ? localized : family, cjk: !!localized, ...(substitute ? { substitute } : {}) });
  const needle = fold(query);
  const matches = (f: { family: string; localized?: string | null }) =>
    !needle || fold(f.family).includes(needle) || (!!f.localized && fold(f.localized).includes(needle));
  const seen = new Set<string>();
  const document = documentFamilies.filter((family) => {
    const key = family.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return matches({ family, localized: byName.get(key)?.localized });
  }).map((family) => entry(family, byName.get(family.toLowerCase())?.localized, byName.get(family.toLowerCase())?.substitute));
  const collator = new Intl.Collator(chinese ? "zh-Hans-CN" : "en");
  const all = installed.filter(matches).map((f) => entry(f.family, f.localized, f.substitute))
    .sort((a, b) => (chinese ? Number(b.cjk) - Number(a.cjk) : 0) || collator.compare(a.label, b.label));
  return { document, all };
}
