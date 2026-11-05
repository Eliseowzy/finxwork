// Cell addresses as Excel writes them (A1, $B$2, A1:C3, 'My sheet'!A1), 1-based, for the
// workbook grid and for the anchors and citations that point into it.

export type Pos = { r: number; c: number };
export type Area = { r1: number; c1: number; r2: number; c2: number };

export const MAX_COLS = 16384;
export const MAX_ROWS = 1048576;

/** A cell or a range, no `$`, no sheet: what a citation or an anchor names. */
export const RANGE = /^[A-Za-z]{1,3}\d+(?::[A-Za-z]{1,3}\d+)?$/;

/** A column's letters: 1 → A, 27 → AA. */
export function colName(c: number): string {
  let s = "";
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export const addr = (p: Pos) => `${colName(p.c)}${p.r}`;

/** `B12` or `$B$12`, within the sheet's bounds. */
export function parseAddr(a: string): Pos | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64;
  const r = Number(m[2]);
  return r >= 1 && r <= MAX_ROWS && c <= MAX_COLS ? { r, c } : null;
}

/** `A1:C3` (either corner first) or a single cell. */
export function parseRange(a: string): Area | null {
  const [x, y] = a.split(":");
  const p = parseAddr(x);
  const q = y ? parseAddr(y) : p;
  return p && q ? { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) } : null;
}

/** The area between two cells. */
export const areaOf = (a: Pos, b: Pos): Area => ({ r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) });

/** `A1`, or `A1:C3` when it is more than one cell. */
export function rangeText(g: Area): string {
  const first = addr({ r: g.r1, c: g.c1 });
  return g.r1 === g.r2 && g.c1 === g.c2 ? first : `${first}:${addr({ r: g.r2, c: g.c2 })}`;
}

/** `Sheet!A1` (the sheet maybe quoted) into the sheet's name and the rest; null without a `!`. */
export function splitRef(ref: string): { sheet: string; cell: string } | null {
  const bang = ref.lastIndexOf("!");
  if (bang < 1) return null;
  return { sheet: ref.slice(0, bang).replace(/^'(.*)'$/, "$1").replace(/''/g, "'"), cell: ref.slice(bang + 1) };
}

/** The cells of `Sheet!A1` refs that are on `sheet`, by address alone. */
export const onSheet = (refs: readonly string[], sheet: string) => refs.map(splitRef).filter((x) => x?.sheet === sheet).map((x) => x!.cell);
