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
