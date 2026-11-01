// The embedded browser's search engines (Settings › Browser › Built-in browser), as Chrome
// keeps them: each one a URL template with `{searchTerms}` where the words go, and a keyword
// that, typed in the address field and followed by Tab or Space, searches with it. The
// built-in ones come with the app; the person can add their own.

export type SearchEngine = {
  /** `google`, `bing`… for the built-in ones; `custom-…` for the person's. */
  id: string;
  name: string;
  /** Typed in the address field, then Tab or Space: search with this engine. */
  keyword: string;
  /** With `{searchTerms}` where the words go. */
  url: string;
  custom?: boolean;
};

export const builtInEngines: readonly SearchEngine[] = [
  { id: "google", name: "Google", keyword: "google.com", url: "https://www.google.com/search?q={searchTerms}" },
  { id: "bing", name: "Microsoft Bing", keyword: "bing.com", url: "https://www.bing.com/search?q={searchTerms}" },
  { id: "baidu", name: "百度", keyword: "baidu.com", url: "https://www.baidu.com/s?wd={searchTerms}" },
  { id: "duckduckgo", name: "DuckDuckGo", keyword: "duckduckgo.com", url: "https://duckduckgo.com/?q={searchTerms}" },
];

export const defaultSearchEngine = "google";

/** The built-in engines and the person's, in that order. */
export const allEngines = (custom: readonly SearchEngine[] = []): SearchEngine[] => [...builtInEngines, ...custom];

export const engineById = (engines: readonly SearchEngine[], id: string | undefined) =>
  engines.find((e) => e.id === id) ?? engines.find((e) => e.id === defaultSearchEngine) ?? engines[0];

/** The engine whose keyword this is, ignoring case. */
export const engineByKeyword = (engines: readonly SearchEngine[], keyword: string) => {
  const k = keyword.trim().toLowerCase();
  return k ? engines.find((e) => e.keyword.toLowerCase() === k) : undefined;
};

/** The engine's results page for `query`. */
export function searchURL(engine: SearchEngine, query: string): string {
  return engine.url.replaceAll("{searchTerms}", encodeURIComponent(query));
}

/** Where an engine's icon comes from: its site. */
export function engineOrigin(engine: Pick<SearchEngine, "url">): string | null {
  try {
    return new URL(engine.url.replaceAll("{searchTerms}", "q")).origin;
  } catch {
    return null;
  }
}

/** A template as the person types it: `%s` stands for the words too. Null when it is not an http(s) URL with a place for them. */
export function templateOf(text: string): string | null {
  const url = text.trim().replaceAll("%s", "{searchTerms}");
  if (!url.includes("{searchTerms}")) return null;
  try {
    const u = new URL(url.replaceAll("{searchTerms}", "q"));
    return u.protocol === "https:" || u.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Why a new engine can't be saved, or null. Keywords are one word and taken once. */
export function engineProblem(e: { name: string; keyword: string; url: string }, engines: readonly SearchEngine[]): "name" | "keyword" | "keywordTaken" | "url" | null {
  if (!e.name.trim() || e.name.trim().length > 60) return "name";
  const keyword = e.keyword.trim();
  if (!keyword || /\s/.test(keyword) || keyword.length > 60) return "keyword";
  if (engineByKeyword(engines, keyword)) return "keywordTaken";
  if (!templateOf(e.url) || e.url.length > 2048) return "url";
  return null;
}

/** The person's engines as saved: what is not a valid engine is dropped, so a bad file can't break the address field. */
export function savedEngines(value: unknown): SearchEngine[] {
  if (!Array.isArray(value)) return [];
  const kept: SearchEngine[] = [];
  for (const v of value.slice(0, 50)) {
    if (typeof v !== "object" || v === null) continue;
    const { id, name, keyword, url } = v as Record<string, unknown>;
    if (typeof id !== "string" || !/^custom-[\w-]{1,64}$/.test(id) || kept.some((k) => k.id === id)) continue;
    if (typeof name !== "string" || typeof keyword !== "string" || typeof url !== "string") continue;
    const template = templateOf(url);
    if (!template || engineProblem({ name, keyword, url }, allEngines(kept))) continue;
    kept.push({ id, name: name.trim(), keyword: keyword.trim(), url: template, custom: true });
  }
  return kept;
}
