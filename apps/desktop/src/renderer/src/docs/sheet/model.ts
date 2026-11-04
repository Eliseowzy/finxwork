import type { CellData, SheetOp } from "@finx/protocol";
import { addr, colName, type Area } from "../cellref.ts";

// The grid's pure parts (spreadsheet-design §8): what a person types as an op, how a cell's
// colour reads on a dark background, a selection as text, and the sizes dragged here.

/** What a person typed, as Excel reads it: a formula, a number (with thousands or %), TRUE/FALSE, text. */
export function inputOp(sheet: string, cell: string, raw: string): SheetOp {
  const v = raw.trim();
  if (v === "") return { op: "clear", sheet, range: cell };
  if (v.startsWith("=") && v.length > 1) return { op: "set_formula", sheet, cell, formula: v };
  if (raw.startsWith("'")) return { op: "set_value", sheet, cell, value: raw.slice(1) };
  const num = /^[+-]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?(e[+-]?\d+)?(%)?$/i.exec(v);
  if (num && /\d/.test(v)) {
    const n = Number(v.replace(/,/g, "").replace("%", ""));
    if (Number.isFinite(n)) return { op: "set_value", sheet, cell, value: num[5] ? n / 100 : n };
  }
  if (/^(true|false)$/i.test(v)) return { op: "set_value", sheet, cell, value: v.toUpperCase() === "TRUE" };
  return { op: "set_value", sheet, cell, value: raw };
}

/** What editing a cell starts from: its formula, else its value as typed, else what it shows. */
export function editTextOf(cell: CellData | undefined): string {
  if (cell?.formula) return cell.formula;
  const v = cell?.value;
  if (v?.type === "number" || v?.type === "bool" || v?.type === "text") return String(v.value);
  return cell?.text ?? "";
}

/** A colour from the file, lightened when it would be lost on a dark background (Excel's blue input font, black text). */
export function readable(hex: string | null | undefined, dark: boolean): string | undefined {
  if (!hex) return undefined;
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (!dark || lum > 0.45) return `#${hex}`;
  const up = (x: number) => Math.round(x + (255 - x) * 0.55);
  return `rgb(${up(r)},${up(g)},${up(b)})`;
}

const rows = (g: Area) => Array.from({ length: g.r2 - g.r1 + 1 }, (_, i) => g.r1 + i);
const cols = (g: Area) => Array.from({ length: g.c2 - g.c1 + 1 }, (_, i) => g.c1 + i);

/** An area's cells as tab-separated lines, as spreadsheets paste them. */
export function toTsv(g: Area, text: (cell: string) => string | undefined): string {
  return rows(g).map((r) => cols(g).map((c) => text(addr({ r, c })) ?? "").join("\t")).join("\n");
}

/** An area's cells as a Markdown table, with the column letters and row numbers. */
export function toMarkdown(g: Area, text: (cell: string) => string | undefined): string {
  const cs = cols(g);
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| | ${cs.map(colName).join(" | ")} |`,
    `|---|${cs.map(() => "---").join("|")}|`,
    ...rows(g).map((r) => `| ${r} | ${cs.map((c) => esc(text(addr({ r, c })) ?? "")).join(" | ")} |`),
  ].join("\n");
}

/** Widths and heights dragged here, by `sheet\0n`: how the grid shows them, not written to the file. */
export type Sizes = { cols: Map<string, number>; rows: Map<string, number> };

export const sizeKey = (sheet: string, n: number) => `${sheet}\u0000${n}`;

/** The sizes of one sheet, by column or row number. */
export function sizesOf(sizes: Map<string, number>, sheet: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const [k, v] of sizes) {
    const [sh, n] = k.split("\u0000");
    if (sh === sheet) out.set(Number(n), v);
  }
  return out;
}

const storageKey = (docId: string) => `finx.sheet.sizes.${docId}`;

export function readSizes(docId: string): Sizes {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey(docId)) ?? "null");
    const entries = (x: unknown): [string, number][] =>
      Array.isArray(x) ? x.filter((v): v is [string, number] => Array.isArray(v) && typeof v[0] === "string" && Number.isFinite(v[1]) && v[1] >= 6 && v[1] <= 10000) : [];
    return { cols: new Map(entries(data?.cols)), rows: new Map(entries(data?.rows)) };
  } catch {
    return { cols: new Map(), rows: new Map() };
  }
}

export function writeSizes(docId: string, sizes: Sizes) {
  try {
    localStorage.setItem(storageKey(docId), JSON.stringify({ cols: [...sizes.cols], rows: [...sizes.rows] }));
  } catch {
    /* Layout remains usable when storage is unavailable. */
  }
}

/** What Excel's status bar shows for a selection: non-empty cells, and over its numbers their sum and average. */
export type SelectionStats = { count: number; numbers: number; sum: number; average: number | null; error: boolean };

/**
 * The selection's figures, as Excel's status bar has them: `count` is every non-empty cell,
 * `sum` and `average` only the numbers (text, TRUE/FALSE and numbers stored as text are not).
 * Null for a single cell or nothing in it. With an error value among them the sum is not told
 * (`error`), as a total that quietly leaves a #REF! out would mislead.
 */
export function selectionStats(cells: readonly CellData[], area: Area): SelectionStats | null {
  if (area.r1 === area.r2 && area.c1 === area.c2) return null;
  let count = 0, numbers = 0, sum = 0, error = false;
  for (const c of cells) {
    if (!c.text && !c.value) continue;
    count++;
    if (c.value?.type === "number") {
      numbers++;
      sum += c.value.value;
    } else if (c.value?.type === "error") error = true;
  }
  if (count === 0) return null;
  return { count, numbers, sum, average: numbers ? sum / numbers : null, error };
}

/**
 * A status-bar figure, short enough to read at a glance: two decimals from 100 up, four below
 * (a ratio or a rate keeps its digits); a click copies the full value.
 */
export function statText(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(n) >= 100 ? 2 : 4 }).format(n);
}

// ── pasting (spreadsheet-design §8.7) ──

/** Text from the clipboard as rows of cells, as Excel puts it there: tabs between cells, quotes around a cell holding a tab, line end or quote. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  const s = text.replace(/\r\n?/g, "\n");
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' && cell === "") {
      // A quoted cell: "" inside is one quote.
      let j = i + 1;
      let quoted = "";
      for (; j < s.length; j++) {
        if (s[j] === '"' && s[j + 1] === '"') (quoted += '"'), j++;
        else if (s[j] === '"') break;
        else quoted += s[j];
      }
      if (j < s.length && (s[j + 1] === "\t" || s[j + 1] === "\n" || j + 1 === s.length)) {
        cell = quoted;
        i = j + 1;
        continue;
      }
    }
    if (ch === "\t") (row.push(cell), (cell = ""));
    else if (ch === "\n") (row.push(cell), rows.push(row), (row = []), (cell = ""));
    else cell += ch;
    i++;
  }
  if (cell !== "" || row.length) (row.push(cell), rows.push(row));
  return rows;
}

/** At most this many cells in one paste, as one edit (finx's own limit for an edit). */
export const MAX_PASTE = 10_000;

/** A paste at `at` (top-left) as edits, each cell read as typed; null when it is more than one edit takes. */
export function pasteOps(sheet: string, at: { r: number; c: number }, rows: string[][]): SheetOp[] | null {
  const n = rows.reduce((k, row) => k + row.length, 0);
  if (n === 0 || n > MAX_PASTE) return null;
  return rows.flatMap((row, i) => row.map((text, j) => inputOp(sheet, addr({ r: at.r + i, c: at.c + j }), text)));
}

// ── display units (spreadsheet-design §8.8): only how numbers show here, never written ──

/** A unit numbers are shown in: 元 is the file's own. */
export const UNITS = [1, 1e3, 1e4, 1e6, 1e8] as const;
export type Unit = (typeof UNITS)[number];

/** How part of a sheet shows its numbers; the last lens over a cell wins. `decimals` null keeps the file's. */
export type Lens = { area: Area; unit: Unit; decimals: number | null };

export function lensAt(lenses: readonly Lens[] | undefined, r: number, c: number): Lens | undefined {
  if (!lenses) return undefined;
  for (let i = lenses.length - 1; i >= 0; i--) {
    const a = lenses[i].area;
    if (r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2) return lenses[i];
  }
  return undefined;
}

/** A plain amount as the file shows it: digits with separators, a sign or brackets, a currency; not %, dates, times or 1E+06. */
const AMOUNT = /^\s*[-+(]?\s*[$¥€£]?\s*-?\d{1,3}(,\d{3})*(\.\d+)?\s*\)?\s*$|^\s*[-+(]?\s*[$¥€£]?\s*-?\d+(\.\d+)?\s*\)?\s*$/;

/** The decimals the file shows a number with. */
export const decimalsOf = (text: string) => /\.(\d+)/.exec(text)?.[1].length ?? 0;

/**
 * A cell as the lens shows it, or null when the lens leaves it as the file shows it: not a
 * number, or shown as a percentage, a date, a time or in scientific notation.
 */
export function lensText(cell: CellData | undefined, lens: Lens | undefined, locale?: string): string | null {
  if (!lens || cell?.value?.type !== "number" || cell.formula?.startsWith("=TEXT(") || !AMOUNT.test(cell.text)) return null;
  const decimals = lens.decimals ?? decimalsOf(cell.text);
  if (lens.unit === 1 && lens.decimals === null) return null;
  const v = cell.value.value / lens.unit;
  const out = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Math.abs(v));
  // Negative as the file shows it: in brackets, or with a minus.
  return v < 0 ? (cell.text.includes("(") ? `(${out})` : `-${out}`) : out;
}

/** The lenses after setting a unit, or moving the decimals, over `area`; cells outside keep theirs. */
export function withLens(lenses: readonly Lens[], area: Area, change: { unit?: Unit; decimals?: (had: number | null) => number | null }): Lens[] {
  const under = lensAt(lenses, area.r1, area.c1);
  const next: Lens = { area, unit: change.unit ?? under?.unit ?? 1, decimals: change.decimals ? change.decimals(under?.decimals ?? null) : (under?.decimals ?? null) };
  // A lens entirely under the new one is gone.
  const kept = lenses.filter((l) => !(l.area.r1 >= area.r1 && l.area.r2 <= area.r2 && l.area.c1 >= area.c1 && l.area.c2 <= area.c2));
  return next.unit === 1 && next.decimals === null && !kept.some((l) => overlaps(l.area, area)) ? kept : [...kept, next];
}

const overlaps = (a: Area, b: Area) => a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;

/** The lenses of a document, by sheet, kept on this Mac (others opening the file see it as it is). */
export function readLenses(docId: string): Record<string, Lens[]> {
  try {
    return JSON.parse(localStorage.getItem(`finx.sheet.lens.${docId}`) ?? "{}");
  } catch {
    return {};
  }
}

export function writeLenses(docId: string, lenses: Record<string, Lens[]>) {
  const kept = Object.fromEntries(Object.entries(lenses).filter(([, l]) => l.length));
  if (Object.keys(kept).length) localStorage.setItem(`finx.sheet.lens.${docId}`, JSON.stringify(kept));
  else localStorage.removeItem(`finx.sheet.lens.${docId}`);
}

// ── hard-coded numbers (spreadsheet-design §8.7) ──

/**
 * A number typed in among formulas: both neighbours across the row are formulas, or both
 * neighbours down the column. As in a row of yearly figures where one year was pasted over
 * with its value, the cell Excel would flag as inconsistent with its neighbours.
 */
export function isHardcoded(at: (r: number, c: number) => CellData | undefined, r: number, c: number): boolean {
  const d = at(r, c);
  if (d?.value?.type !== "number" || d.formula) return false;
  const f = (rr: number, cc: number) => !!at(rr, cc)?.formula;
  return (f(r, c - 1) && f(r, c + 1)) || (f(r - 1, c) && f(r + 1, c));
}
