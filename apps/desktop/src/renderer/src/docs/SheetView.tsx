import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { baseName, RpcError, type RpcClient } from "@finx/client";
import type { CellData, Impact, SheetInfo, SheetOp } from "@finx/protocol";
import { Icon } from "../icons";
import { errorText, useStore } from "../store";
import { openRef } from "../session/contentMenus";
import { quoteToComposer, setDocInfo, setSheetViewing, type DocTab, type Jump } from "./state";

// A workbook in the file panel (spreadsheet-design §8): a bar with the address and the formula,
// the grid, and the sheets underneath. Cells are read from finx by blocks of rows as they come
// into sight (doc/cells); edits go back as SheetOps (doc/apply) and come back with their impact,
// which the grid lights up. The agent's edits arrive as a new revision of the document.

type Pos = { r: number; c: number };
type Sel = { anchor: Pos; focus: Pos };
type Merge = { r1: number; c1: number; r2: number; c2: number };

const BLOCK = 100;
const MAX_COLS = 16384;
const MAX_ROWS = 1048576;
const HEAD_W = 44;
const HEAD_H = 22;

const colName = (c: number) => {
  let s = "";
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const addr = (p: Pos) => `${colName(p.c)}${p.r}`;
function parseAddr(a: string): Pos | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64;
  const r = Number(m[2]);
  return r >= 1 && r <= 1048576 && c <= 16384 ? { r, c } : null;
}
function parseRange(a: string): Merge | null {
  const [x, y] = a.split(":");
  const p = parseAddr(x);
  const q = y ? parseAddr(y) : p;
  return p && q ? { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) } : null;
}
const rectOf = (s: Sel): Merge => ({ r1: Math.min(s.anchor.r, s.focus.r), c1: Math.min(s.anchor.c, s.focus.c), r2: Math.max(s.anchor.r, s.focus.r), c2: Math.max(s.anchor.c, s.focus.c) });

/** A colour from the file, lightened when it would be lost on a dark background (Excel's blue input font, black text). */
function readable(hex: string | null | undefined): string | undefined {
  if (!hex) return undefined;
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (!dark || lum > 0.45) return `#${hex}`;
  const up = (x: number) => Math.round(x + (255 - x) * 0.55);
  return `rgb(${up(r)},${up(g)},${up(b)})`;
}

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

type Cache = { key: string; cells: Map<string, CellData>; blocks: Set<number>; merges: Merge[]; heights: Map<number, number> };

type Activity = { revision: number; title: string; impact?: Impact };

export function SheetView({ rpc, session, tab, jump, activeView = true }: { rpc: RpcClient; session: string; tab: DocTab; jump?: Jump | null; activeView?: boolean }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const info = tab.info;
  const docId = info.doc_id;
  const sheets = (info.sheets ?? []).filter((s) => !s.hidden);
  const [sheetName, setSheetName] = useState(() => sheets.find((s) => !s.chart)?.name ?? sheets[0]?.name ?? "");
  const sheet: SheetInfo | undefined = (info.sheets ?? []).find((s) => s.name === sheetName);
  const [sel, setSel] = useState<Sel>({ anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 } });
  const [editing, setEditing] = useState<{ text: string; inBar: boolean } | null>(null);
  const [lit, setLit] = useState<{ edited: Set<string>; affected: Set<string> } | null>(null);
  const [impact, setImpact] = useState<{ impact: Impact; byAgent: boolean } | null>(null);
  const [note, setNote] = useState<{ text: string; kind: "refused" | "conflict" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [extent, setExtent] = useState({ rows: 100, cols: 26 });
  const [agentNotice, setAgentNotice] = useState<{ count: number; first?: string } | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [, redraw] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  /** The zoom buttons: about the view's top left. */
  const setZoomTo = (z: number) => {
    const el = scroller.current;
    const next = Math.min(3, Math.max(0.5, Math.round(z * 100) / 100));
    if (!el) return;
    const x = el.scrollLeft / zoomRef.current;
    const y = el.scrollTop / zoomRef.current;
    zoomRef.current = next;
    setZoom(next);
    requestAnimationFrame(() => {
      el.scrollLeft = x * next;
      el.scrollTop = y * next;
      // The browser keeps the scroll within the new size: read back where it is.
      setView({ top: el.scrollTop / next, left: el.scrollLeft / next, w: el.clientWidth / next, h: el.clientHeight / next });
    });
  };
  const grid = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, w: 800, h: 600 });
  const cache = useRef<Cache>({ key: "", cells: new Map(), blocks: new Set(), merges: [], heights: new Map() });
  const own = useRef<number | null>(null);

  // ── the sheet's shape ──
  const used = parseRange(sheet?.used ?? "A1") ?? { r1: 1, c1: 1, r2: 1, c2: 1 };
  const nCols = Math.min(MAX_COLS, Math.max(used.c2 + 5, extent.cols, 26));
  const nRows = Math.min(MAX_ROWS, Math.max(used.r2 + 50, extent.rows, 100));
  // Widths and heights dragged here, by sheet: how the grid shows them, not written to the file.
  const [sized, setSized] = useState<{ cols: Map<string, number>; rows: Map<string, number> }>(() => ({ cols: new Map(), rows: new Map() }));
  const widths = useMemo(() => {
    const w = new Array(nCols + 1).fill(sheet?.default_width ?? 64);
    for (const c of sheet?.columns ?? []) for (let i = c.first; i <= Math.min(c.last, nCols); i++) w[i] = c.hidden ? 0 : c.width;
    for (const [k, v] of sized.cols) {
      const [sh, c] = k.split("\u0000");
      if (sh === sheetName && Number(c) <= nCols) w[Number(c)] = v;
    }
    return w as number[];
  }, [sheet, nCols, sized, sheetName]);
  const colLeft = useMemo(() => {
    const x = [0, 0];
    for (let c = 1; c <= nCols; c++) x[c + 1] = x[c] + widths[c];
    return x;
  }, [widths, nCols]);
  const c0 = cache.current;
  const defH = sheet?.default_height ?? 20;
  const rowMetrics = useMemo(() => {
    const merged = new Map(c0.heights);
    for (const [k, v] of sized.rows) {
      const [sh, r] = k.split("\u0000");
      if (sh === sheetName) merged.set(Number(r), v);
    }
    const rows = [...merged.entries()].filter(([r]) => r <= nRows).sort((a, b) => a[0] - b[0]);
    const extra = [0];
    for (const [, height] of rows) extra.push(extra[extra.length - 1] + height - defH);
    return { rows, extra };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nRows, defH, c0.heights.size, c0.key, sized, sheetName]);
  const rowY = useCallback((row: number) => {
    let lo = 0, hi = rowMetrics.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowMetrics.rows[mid][0] < row) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, row - 1) * defH + rowMetrics.extra[lo];
  }, [rowMetrics, defH]);
  const frozen = { rows: Number(sheet?.frozen?.[0] ?? 0), cols: Number(sheet?.frozen?.[1] ?? 0) };
  const frozenH = rowY(frozen.rows + 1);
  const frozenW = colLeft[frozen.cols + 1];

  // ── reading cells ──
  const load = useCallback(
    async (block: number) => {
      const c = cache.current;
      const key = c.key;
      if (c.blocks.has(block) || !sheet || sheet.chart) return;
      c.blocks.add(block);
      const r1 = block * BLOCK + 1;
      try {
        const res = await rpc.request("doc/cells", { session_id: session, doc_id: docId, sheet: sheet.name, range: `A${r1}:${colName(nCols)}${r1 + BLOCK - 1}` });
        if (cache.current.key !== key) return;
        for (const cell of res.cells) c.cells.set(cell.cell, cell);
        for (const m of res.merges ?? []) {
          const g = parseRange(m);
          if (g && !c.merges.some((x) => x.r1 === g.r1 && x.c1 === g.c1)) c.merges.push(g);
        }
        for (const h of res.rows ?? []) c.heights.set(h.row, h.hidden ? 0 : h.height);
        redraw((n) => n + 1);
        setLoadError(null);
      } catch (error) {
        if (cache.current.key === key) setLoadError(errorText(error));
        c.blocks.delete(block);
      }
    },
    [rpc, session, docId, sheet, nCols],
  );

  /** Everything read is stale: read again what is in sight; with `diff`, cells that changed light up. */
  const reread = useCallback(
    (diff: boolean) => {
      const old = cache.current;
      const key = `${docId}:${sheetName}:${info.revision}`;
      cache.current = { key, cells: new Map(), blocks: new Set(), merges: [], heights: new Map(old.heights) };
      const first = Math.floor(Math.max(0, rowAt(view.top) - 1) / BLOCK);
      const last = Math.floor(rowAt(view.top + view.h) / BLOCK);
      void Promise.all(Array.from({ length: last - first + 1 }, (_, i) => load(first + i))).then(() => {
        if (!diff) return;
        const changed = new Set<string>();
        for (const [k, v] of cache.current.cells) if (old.cells.has(k) && old.cells.get(k)!.text !== v.text) changed.add(k);
        for (const k of old.cells.keys()) if (!cache.current.cells.has(k) && old.cells.get(k)!.text) changed.add(k);
        if (changed.size) {
          setLit({ edited: new Set(), affected: changed });
          const first = changed.values().next().value as string | undefined;
          setAgentNotice({ count: changed.size, first });
          setActivity((items) => [{ revision: info.revision, title: t("sheet.agentChanged", { count: changed.size }) }, ...items].slice(0, 20));
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docId, sheetName, info.revision, load, view.top, view.h, t],
  );

  function rowAt(y: number) {
    let lo = 1;
    let hi = nRows;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rowY(mid) <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  function colAt(x: number) {
    let c = 1;
    while (c < nCols && colLeft[c + 1] <= x) c++;
    return c;
  }

  // A new sheet, or a new revision (an edit here, or the agent's): read again.
  useEffect(() => {
    const byAgent = own.current !== info.revision && cache.current.key.startsWith(`${docId}:${sheetName}:`);
    reread(byAgent);
    if (byAgent) setImpact(null);
    else if (own.current === info.revision) own.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, sheetName, info.revision]);

  // Blocks in sight.
  useEffect(() => {
    const first = Math.floor(Math.max(0, rowAt(view.top) - 1) / BLOCK);
    const last = Math.floor(rowAt(view.top + view.h) / BLOCK);
    for (let b = first; b <= last; b++) void load(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, load, cache.current.key]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop / zoomRef.current, left: el.scrollLeft / zoomRef.current, w: el.clientWidth / zoomRef.current, h: el.clientHeight / zoomRef.current });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Pinch on a trackpad (and ⌘ with the wheel): the grid zooms about the pointer, as in Excel.
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const old = zoomRef.current;
      const next = Math.min(3, Math.max(0.5, old * Math.exp(-e.deltaY * 0.006)));
      if (next === old) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const x = (el.scrollLeft + px) / old;
      const y = (el.scrollTop + py) / old;
      zoomRef.current = next;
      setZoom(next);
      requestAnimationFrame(() => {
        el.scrollLeft = x * next - px;
        el.scrollTop = y * next - py;
        measure();
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", wheel);
    };
  }, [sheetName]);

  // ── editing ──
  const active = sel.focus;
  const activeCell = cache.current.cells.get(addr(active));
  const selected = rectOf(sel);
  const selectedRange = selected.r1 === selected.r2 && selected.c1 === selected.c2
    ? addr({ r: selected.r1, c: selected.c1 })
    : `${addr({ r: selected.r1, c: selected.c1 })}:${addr({ r: selected.r2, c: selected.c2 })}`;
  const editable = !sheet?.protected && !!info.capabilities.includes("edit_values");
  const editText = activeCell?.formula ?? (activeCell?.value?.type === "number" || activeCell?.value?.type === "bool" || activeCell?.value?.type === "text" ? String(activeCell.value.value) : activeCell?.text ?? "");
  const shown = (p: Pos) => cache.current.cells.get(addr(p));

  useEffect(() => {
    if (!activeView || !sheet || sheet.chart) return;
    setSheetViewing(session, { doc_id: docId, path: info.path, sheet: sheet.name, range: selectedRange, text: activeCell?.text ?? "" });
    return () => setSheetViewing(session, null, docId);
  }, [activeView, session, docId, info.path, sheet, selectedRange, activeCell?.text]);

  useEffect(() => {
    if (!jump || jump.doc_id !== docId || jump.anchor.kind !== "cells") return;
    const range = parseRange(jump.anchor.range);
    if (!range) return;
    setSheetName(jump.anchor.sheet);
    setExtent((x) => ({ rows: Math.max(x.rows, range.r2 + 20), cols: Math.max(x.cols, range.c2 + 5) }));
    setSel({ anchor: { r: range.r1, c: range.c1 }, focus: { r: range.r2, c: range.c2 } });
    setLit({ edited: new Set(), affected: new Set([addr({ r: range.r1, c: range.c1 })]) });
  }, [jump?.seq, docId]);

  const apply = useCallback(
    async (ops: SheetOp[]) => {
      if (!sheet || !editable || busy) return;
      setBusy(true);
      try {
        const r = await rpc.request("doc/apply", { session_id: session, doc_id: docId, ops, base_revision: info.revision });
        own.current = r.revision;
        setDocInfo(session, { ...info, revision: r.revision, dirty: r.dirty });
        setNote(null);
        const name = (x: string) => x.slice(x.lastIndexOf("!") + 1);
        const mine = (x: string) => x.startsWith(`${sheet.name}!`);
        setLit({ edited: new Set(r.impact.edited.filter((e) => e.sheet === sheet.name).map((e) => e.cell)), affected: new Set((r.impact.affected ?? []).filter(mine).map(name)) });
        setImpact(r.impact.affected_count || r.impact.key_outputs?.length || r.impact.needs_excel?.length ? { impact: r.impact, byAgent: false } : null);
        setActivity((items) => [{ revision: r.revision, title: t("sheet.youChanged", { count: r.impact.edited.length }), impact: r.impact }, ...items].slice(0, 20));
        setAgentNotice(null);
      } catch (e) {
        if (e instanceof RpcError && e.kind === "doc_refused") setNote({ text: e.message, kind: "refused" });
        else st.show(errorText(e), undefined, true);
      } finally {
        setBusy(false);
      }
    },
    [rpc, session, docId, info, sheet, st, editable, busy, t],
  );

  // One commit per edit: Enter commits, then the editor's blur would again.
  const committing = useRef(false);
  const commit = (text: string) => {
    if (committing.current) return;
    committing.current = true;
    queueMicrotask(() => (committing.current = false));
    setEditing(null);
    const cell = addr(active);
    const before = editText;
    if (text !== before && sheet) void apply([inputOp(sheet.name, cell, text)]);
    grid.current?.focus();
  };

  const history = async (which: "doc/undo" | "doc/redo") => {
    try {
      const r = await rpc.request(which, { session_id: session, doc_id: docId });
      own.current = r.revision;
      setDocInfo(session, { ...info, revision: r.revision, dirty: r.dirty });
      setImpact(null);
      setLit(null);
      setActivity((items) => [{ revision: r.revision, title: t(which === "doc/undo" ? "sheet.undone" : "sheet.redone"), impact: r.impact }, ...items].slice(0, 20));
    } catch (e) {
      st.show(errorText(e), undefined, true);
    }
  };

  const save = async (force = false) => {
    try {
      const next = await rpc.request("doc/save", { session_id: session, doc_id: docId, force });
      setDocInfo(session, next);
      setNote(null);
      st.show(t("sheet.saved"));
      return true;
    } catch (e) {
      if (e instanceof RpcError && e.kind === "doc_conflict") setNote({ text: t("sheet.conflict"), kind: "conflict" });
      else st.show(errorText(e), undefined, true);
      return false;
    }
  };

  const saveAs = async () => {
    const path = window.finx ? await window.finx.pickSaveFile(info.path) : window.prompt(t("sheet.saveAsPrompt"), info.path);
    if (!path) return;
    try {
      const next = await rpc.request("doc/save", { session_id: session, doc_id: docId, path, force: false });
      setDocInfo(session, next);
      st.show(t("sheet.savedAs", { name: baseName(path) }));
    } catch (error) {
      st.show(errorText(error), undefined, true);
    }
  };

  const openExcel = async () => {
    if (info.dirty && !(await save())) return;
    void openRef(st, { path: info.path, rel: null, kind: "file" }, undefined, "system");
  };

  const cellsInSelection = async () => {
    if (!sheet) throw new Error(t("sheet.empty"));
    return rpc.request("doc/cells", { session_id: session, doc_id: docId, sheet: sheet.name, range: selectedRange });
  };

  const copySelection = async () => {
    try {
      const result = await cellsInSelection();
      const values = new Map(result.cells.map((cell) => [cell.cell, cell.text]));
      const rows: string[] = [];
      for (let r = selected.r1; r <= selected.r2; r++) {
        const line: string[] = [];
        for (let c = selected.c1; c <= selected.c2; c++) line.push(values.get(addr({ r, c })) ?? "");
        rows.push(line.join("\t"));
      }
      await navigator.clipboard.writeText(rows.join("\n"));
      st.show(t("sheet.copied"));
    } catch (error) { st.show(errorText(error), undefined, true); }
  };

  const quoteSelection = async () => {
    if (!sheet) return;
    const count = (selected.r2 - selected.r1 + 1) * (selected.c2 - selected.c1 + 1);
    let text = t("sheet.selectionSummary", { range: `${sheet.name}!${selectedRange}`, count });
    if (count <= 200) {
      try {
        const result = await cellsInSelection();
        const values = new Map(result.cells.map((cell) => [cell.cell, cell.text]));
        const cols = Array.from({ length: selected.c2 - selected.c1 + 1 }, (_, i) => selected.c1 + i);
        const lines = [
          `| | ${cols.map(colName).join(" | ")} |`,
          `|---|${cols.map(() => "---").join("|")}|`,
          ...Array.from({ length: selected.r2 - selected.r1 + 1 }, (_, i) => {
            const r = selected.r1 + i;
            return `| ${r} | ${cols.map((c) => (values.get(addr({ r, c })) ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;
          }),
        ];
        text = `${sheet.name}!${selectedRange}\n\n${lines.join("\n")}`;
      } catch (error) {
        st.show(errorText(error), undefined, true);
        return;
      }
    }
    quoteToComposer(session, { quote: { path: info.path, doc_id: docId, sheet: sheet.name, range: selectedRange, text } });
    st.show(t("sheet.quoted"));
  };

  // ── moving ──
  const reveal = (p: Pos) => {
    const el = scroller.current;
    if (!el) return;
    const top = rowY(p.r) + HEAD_H;
    const bottom = rowY(p.r + 1) + HEAD_H;
    const left = colLeft[p.c] + HEAD_W;
    const right = colLeft[p.c + 1] + HEAD_W;
    const z = zoomRef.current;
    const st = el.scrollTop / z;
    const sl = el.scrollLeft / z;
    if (p.r > frozen.rows) {
      if (top - frozenH < st + HEAD_H) el.scrollTop = (top - HEAD_H - frozenH) * z;
      else if (bottom > st + el.clientHeight / z) el.scrollTop = (bottom - el.clientHeight / z) * z;
    }
    if (p.c > frozen.cols) {
      if (left - frozenW < sl + HEAD_W) el.scrollLeft = (left - HEAD_W - frozenW) * z;
      else if (right > sl + el.clientWidth / z) el.scrollLeft = (right - el.clientWidth / z) * z;
    }
  };
  const go = (p: Pos, extend: boolean) => {
    const q = { r: Math.min(MAX_ROWS, Math.max(1, p.r)), c: Math.min(MAX_COLS, Math.max(1, p.c)) };
    setExtent((x) => ({ rows: Math.max(x.rows, q.r + 20), cols: Math.max(x.cols, q.c + 5) }));
    setSel((s) => (extend ? { anchor: s.anchor, focus: q } : { anchor: q, focus: q }));
    requestAnimationFrame(() => reveal(q));
  };
  const jumpCell = (targetSheet: string, cell: string) => {
    const p = parseAddr(cell);
    if (!p) return;
    setSheetName(targetSheet);
    setExtent((x) => ({ rows: Math.max(x.rows, p.r + 20), cols: Math.max(x.cols, p.c + 5) }));
    setSel({ anchor: p, focus: p });
    setImpact(null);
    setAgentNotice(null);
    requestAnimationFrame(() => reveal(p));
  };
  /** ⌘+arrow: to the edge of the data, as Excel goes. */
  const edge = (p: Pos, dr: number, dc: number): Pos => {
    const filled = (q: Pos) => !!shown(q)?.text;
    let q = { ...p };
    const next = (x: Pos) => ({ r: x.r + dr, c: x.c + dc });
    const inside = (x: Pos) => x.r >= 1 && x.c >= 1 && x.r <= Math.max(used.r2, 1) && x.c <= Math.max(used.c2, 1);
    const startFilled = filled(q) && inside(next(q)) && filled(next(q));
    if (startFilled) {
      while (inside(next(q)) && filled(next(q))) q = next(q);
    } else {
      q = next(q);
      while (inside(q) && !filled(q)) q = next(q);
      if (!inside(q)) q = { r: dr ? (dr > 0 ? used.r2 : 1) : p.r, c: dc ? (dc > 0 ? used.c2 : 1) : p.c };
    }
    return q;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = e.metaKey || e.ctrlKey;
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (mod && e.altKey && e.key.toLowerCase() === "e") {
      void openExcel();
    } else if (arrows[e.key]) {
      const [dr, dc] = arrows[e.key];
      go(mod ? edge(sel.focus, dr, dc) : { r: sel.focus.r + dr, c: sel.focus.c + dc }, e.shiftKey);
    } else if (e.key === "Enter" || e.key === "Tab") {
      const back = e.shiftKey ? -1 : 1;
      go(e.key === "Enter" ? { r: active.r + back, c: active.c } : { r: active.r, c: active.c + back }, false);
    } else if (e.key === "F2") {
      editable && setEditing({ text: editText, inBar: false });
    } else if ((e.key === "Backspace" || e.key === "Delete") && sheet && editable) {
      const g = rectOf(sel);
      void apply([{ op: "clear", sheet: sheet.name, range: `${addr({ r: g.r1, c: g.c1 })}:${addr({ r: g.r2, c: g.c2 })}` }]);
    } else if (mod && e.key.toLowerCase() === "z") {
      void history(e.shiftKey ? "doc/redo" : "doc/undo");
    } else if (mod && e.key.toLowerCase() === "s") {
      void (e.shiftKey ? saveAs() : save());
    } else if (mod && e.key.toLowerCase() === "c") {
      void copySelection();
    } else if (mod && e.key.toLowerCase() === "l") {
      void quoteSelection();
    } else if (!mod && e.key.length === 1 && editable) {
      setEditing({ text: e.key, inBar: false });
    } else if (e.key === "Escape") {
      setLit(null);
    } else return;
    e.preventDefault();
  };

  // ── drawing ──
  const firstRow = Math.max(frozen.rows + 1, rowAt(view.top + frozenH) - 2);
  const lastRow = Math.min(nRows, rowAt(view.top + view.h) + 2);
  const firstCol = Math.max(frozen.cols + 1, colAt(view.left + frozenW) - 1);
  const lastCol = Math.min(nCols, colAt(view.left + view.w) + 1);
  const rowsShown: number[] = [...Array.from({ length: frozen.rows }, (_, i) => i + 1), ...Array.from({ length: Math.max(0, lastRow - firstRow + 1) }, (_, i) => firstRow + i)];
  const colsShown: number[] = [...Array.from({ length: frozen.cols }, (_, i) => i + 1), ...Array.from({ length: Math.max(0, lastCol - firstCol + 1) }, (_, i) => firstCol + i)];
  const merges = cache.current.merges;
  const mergeAt = (r: number, c: number) => merges.find((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2);
  const g = selected;

  /** Where a cell is drawn in the canvas: frozen rows and columns stay where the view starts. */
  const place = (r: number, c: number, w: number, h: number): CSSProperties => {
    const fr = r <= frozen.rows;
    const fc = c <= frozen.cols;
    return {
      left: (fc ? view.left : 0) + HEAD_W + colLeft[c],
      top: (fr ? view.top : 0) + HEAD_H + rowY(r),
      width: w,
      height: h,
      zIndex: fr && fc ? 4 : fr || fc ? 3 : 1,
    };
  };

  const cells: React.ReactNode[] = [];
  for (const r of rowsShown) {
    if (rowY(r + 1) === rowY(r)) continue;
    for (const c of colsShown) {
      if (!widths[c]) continue;
      const m = mergeAt(r, c);
      if (m && (m.r1 !== r || m.c1 !== c)) {
        // Covered by a merge whose top-left is out of sight: draw it here once.
        const firstShown = r === Math.max(m.r1, rowsShown[0]) && c === Math.max(m.c1, colsShown[0]);
        if (!(firstShown && (m.r1 < rowsShown[0] || m.c1 < colsShown[0]))) continue;
      }
      const a = m ? { r: m.r1, c: m.c1 } : { r, c };
      const key = addr(a);
      const d = cache.current.cells.get(key);
      const w = m ? colLeft[m.c2 + 1] - colLeft[m.c1] : widths[c];
      const h = m ? rowY(m.r2 + 1) - rowY(m.r1) : rowY(r + 1) - rowY(r);
      const num = d?.value?.type === "number";
      const align = d?.look?.align ?? (num ? "right" : d?.value?.type === "bool" || d?.value?.type === "error" ? "center" : "left");
      // Text runs on over empty cells to its right, as in Excel.
      let span = w;
      if (!m && d?.text && align === "left" && !num) {
        for (let k = c + 1; k <= Math.min(nCols, c + 12) && !cache.current.cells.get(addr({ r, c: k }))?.text && !mergeAt(r, k); k++) span += widths[k];
      }
      const style: CSSProperties = {
        ...place(a.r, a.c, w, h),
        color: readable(d?.look?.color),
        background: d?.look?.fill ? `#${d.look?.fill}` : undefined,
        fontWeight: d?.look?.bold ? 600 : undefined,
        fontStyle: d?.look?.italic ? "italic" : undefined,
        justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start",
      };
      const cls = ["sht-c", d?.text ? "has" : "", lit?.edited.has(key) ? "edited" : "", lit?.affected.has(key) ? "lit" : "", m ? "merged" : ""].join(" ");
      cells.push(
        <div key={`${r}:${c}`} data-cell={key} className={cls} style={style} title={d?.formula ?? undefined}>
          {d?.text && <span style={span > w ? { width: span, background: d.look?.fill ? undefined : "var(--sht-bg)" } : undefined}>{d.text}</span>}
        </div>,
      );
    }
  }

  const heads: React.ReactNode[] = [];
  for (const c of colsShown) {
    if (!widths[c]) continue;
    const fc = c <= frozen.cols;
    const on = c >= g.c1 && c <= g.c2;
    heads.push(<div key={`h${c}`} className={`sht-h col ${on ? "on" : ""}`} style={{ left: (fc ? view.left : 0) + HEAD_W + colLeft[c], top: view.top, width: widths[c], height: HEAD_H, zIndex: fc ? 7 : 6 }} onMouseDown={(e) => {
      e.stopPropagation();
      setSel({ anchor: { r: 1, c }, focus: { r: Math.max(used.r2, 1), c } });
      grid.current?.focus();
    }}>{colName(c)}</div>);
  }
  /** Dragging a header's edge, as in Excel: the column (or row) before it takes the new size. */
  const resize = (kind: "cols" | "rows", n: number, start: number, from: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const z = zoomRef.current;
    const move = (ev: MouseEvent) => {
      const size = Math.max(kind === "cols" ? 8 : 6, Math.round(start + ((kind === "cols" ? ev.clientX : ev.clientY) - from) / z));
      setSized((x) => {
        const next = { cols: new Map(x.cols), rows: new Map(x.rows) };
        next[kind].set(`${sheetName}\u0000${n}`, size);
        return next;
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = kind === "cols" ? "col-resize" : "row-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  for (const c of colsShown) {
    if (!widths[c]) continue;
    const fc = c <= frozen.cols;
    heads.push(<div key={`hg${c}`} className="sht-grip col" style={{ left: (fc ? view.left : 0) + HEAD_W + colLeft[c + 1] - 3, top: view.top, height: HEAD_H, zIndex: 9 }} onMouseDown={(e) => resize("cols", c, widths[c], e.clientX)(e)} />);
  }
  for (const r of rowsShown) {
    const h = rowY(r + 1) - rowY(r);
    if (!h) continue;
    const frg = r <= frozen.rows;
    heads.push(<div key={`rg${r}`} className="sht-grip row" style={{ left: view.left, top: (frg ? view.top : 0) + HEAD_H + rowY(r + 1) - 3, width: HEAD_W, zIndex: 9 }} onMouseDown={(e) => resize("rows", r, h, e.clientY)(e)} />);
  }
  for (const r of rowsShown) {
    const h = rowY(r + 1) - rowY(r);
    if (!h) continue;
    const fr = r <= frozen.rows;
    const on = r >= g.r1 && r <= g.r2;
    heads.push(<div key={`r${r}`} className={`sht-h row ${on ? "on" : ""}`} style={{ left: view.left, top: (fr ? view.top : 0) + HEAD_H + rowY(r), width: HEAD_W, height: h, zIndex: fr ? 7 : 6 }} onMouseDown={(e) => {
      e.stopPropagation();
      setSel({ anchor: { r, c: 1 }, focus: { r, c: Math.max(used.c2, 1) } });
      grid.current?.focus();
    }}>{r}</div>);
  }

  const selBox = (() => {
    const m = mergeAt(active.r, active.c);
    const box = m && g.r1 === g.r2 && g.c1 === g.c2 ? m : g;
    const p = place(box.r1, box.c1, colLeft[box.c2 + 1] - colLeft[box.c1], rowY(box.r2 + 1) - rowY(box.r1));
    return { ...p, zIndex: 5 };
  })();
  const activeBox = place(active.r, active.c, widths[active.c], rowY(active.r + 1) - rowY(active.r));

  const pick = (e: React.MouseEvent) => {
    const el = scroller.current!;
    const rect = el.getBoundingClientRect();
    const z = zoomRef.current;
    const x = (e.clientX - rect.left) / z - HEAD_W;
    const y = (e.clientY - rect.top) / z - HEAD_H;
    if (x < 0 || y < 0) return null;
    const r = y < frozenH ? rowAt(y) : rowAt(y + el.scrollTop / z);
    const c = x < frozenW ? colAt(x) : colAt(x + el.scrollLeft / z);
    const m = mergeAt(r, c);
    return m ? { r: m.r1, c: m.c1 } : { r, c };
  };

  const bar = editing?.text ?? editText;
  const dirty = info.dirty;

  if (!sheet) return <div className="fpn-empty">{t("sheet.empty")}</div>;
  return (
    <div className="sht" onKeyDown={onKey}>
      <div className="dcp-bar sht-bar">
        <input
          className="sht-name"
          aria-label={t("sheet.address")}
          defaultValue={addr(active)}
          key={addr(active)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key !== "Enter") return;
            const p = parseAddr((e.target as HTMLInputElement).value);
            if (p) go(p, false);
            grid.current?.focus();
          }}
        />
        <span className="sht-fx">fx</span>
        <input
          className="sht-formula"
          aria-label={t("sheet.formula")}
          value={bar}
          readOnly={!editable}
          onFocus={() => editable && !editing && setEditing({ text: bar, inBar: true })}
          onChange={(e) => setEditing({ text: e.target.value, inBar: true })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit(editing?.text ?? bar);
            else if (e.key === "Escape") {
              setEditing(null);
              grid.current?.focus();
            }
          }}
        />
        <div className="dcp-bar-end">
          {busy && <span className="mini-spin" />}
          <span className={`fpn-state ${dirty ? "dirty" : ""}`}>{dirty ? t("sheet.unsaved") : ""}</span>
          <button className="tb" title={t("sheet.undo")} aria-label={t("sheet.undo")} onClick={() => void history("doc/undo")}><Icon name="undo" /></button>
          <button className="tb sht-redo" title={t("sheet.redo")} aria-label={t("sheet.redo")} onClick={() => void history("doc/redo")}><Icon name="undo" /></button>
          <button className={`tb ${showHistory ? "on" : ""}`} title={t("sheet.history")} aria-label={t("sheet.history")} onClick={() => setShowHistory((v) => !v)}><Icon name="clock" /></button>
          <button className="tb" title={t("sheet.save")} aria-label={t("sheet.save")} disabled={!dirty} onClick={() => void save()}><Icon name="save" /></button>
          <button className="tb" title={t("sheet.openExcel")} aria-label={t("sheet.openExcel")} onClick={() => void openExcel()}><Icon name="ext" /></button>
        </div>
      </div>
      {showHistory && (
        <div className="sht-history" role="dialog" aria-label={t("sheet.history")}>
          <div className="sht-history-head"><b>{t("sheet.history")}</b><button className="tb" aria-label={t("sheet.dismiss")} onClick={() => setShowHistory(false)}><Icon name="x" /></button></div>
          {activity.length ? activity.map((item, i) => (
            <button key={`${item.revision}:${i}`} className="sht-history-row" onClick={() => item.impact && (setImpact({ impact: item.impact, byAgent: false }), setShowHistory(false))}>
              <span>{item.title}</span><small>r{item.revision}</small>
            </button>
          )) : <div className="sht-history-empty">{t("sheet.noHistory")}</div>}
        </div>
      )}
      {loadError && <div className="fpn-note" role="alert"><span>{t("sheet.loadFailed")} {loadError}</span><button className="btn sm" onClick={() => { setLoadError(null); reread(false); }}>{t("files.retry")}</button></div>}
      {!editable && !sheet.chart && <div className="fpn-note" role="status"><Icon name="lock" /><span>{t("sheet.readOnly")}</span><button className="btn sm" onClick={() => void openExcel()}>{t("sheet.openExcel")}</button></div>}
      {agentNotice && <div className="sht-agent" role="status"><Icon name="sparkle" /><span>{t("sheet.agentChanged", { count: agentNotice.count })}</span>{agentNotice.first && <button className="btn sm" onClick={() => jumpCell(sheet.name, agentNotice.first!)}>{agentNotice.first}</button>}<button className="tb" aria-label={t("sheet.dismiss")} onClick={() => setAgentNotice(null)}><Icon name="x" /></button></div>}
      {impact && <ImpactBar impact={impact.impact} onClose={() => setImpact(null)} onJump={jumpCell} />}
      {sheet.chart ? (
        <div className="fpn-empty sht-chart"><Icon name="grid" /><span>{t("sheet.chart")}</span><button className="btn" onClick={() => void openExcel()}>{t("sheet.openExcel")}</button></div>
      ) : (
        <div
          ref={scroller}
          className="sht-scroll"
          onScroll={(e) => {
            const el = e.currentTarget;
            const z = zoomRef.current;
            setView({ top: el.scrollTop / z, left: el.scrollLeft / z, w: el.clientWidth / z, h: el.clientHeight / z });
          }}
        >
          <div
            ref={grid}
            className="sht-canvas"
            tabIndex={0}
            style={{ width: HEAD_W + colLeft[nCols + 1], height: HEAD_H + rowY(nRows + 1), zoom }}
            onMouseDown={(e) => {
              const p = pick(e);
              if (!p) return;
              if (editing) commit(editing.text);
              go(p, e.shiftKey);
              grid.current?.focus();
              const move = (ev: MouseEvent) => {
                const q = pick(ev as unknown as React.MouseEvent);
                if (q) setSel((s) => ({ anchor: s.anchor, focus: q }));
              };
              const up = () => {
                window.removeEventListener("mousemove", move);
                window.removeEventListener("mouseup", up);
              };
              window.addEventListener("mousemove", move);
              window.addEventListener("mouseup", up);
            }}
            onDoubleClick={() => editable && setEditing({ text: editText, inBar: false })}
          >
            <div className="sht-corner" style={{ left: view.left, top: view.top, width: HEAD_W, height: HEAD_H }} onMouseDown={(e) => {
              e.stopPropagation();
              setSel({ anchor: { r: 1, c: 1 }, focus: { r: Math.max(used.r2, 1), c: Math.max(used.c2, 1) } });
              grid.current?.focus();
            }} />
            {heads}
            {cells}
            <div className="sht-sel" style={selBox} />
            <div className="sht-active" style={{ ...activeBox, zIndex: 5 }} />
            {editing && !editing.inBar && (
              <input
                autoFocus
                className="sht-edit"
                style={{ ...activeBox, minWidth: activeBox.width as number, zIndex: 8 }}
                value={editing.text}
                onChange={(e) => setEditing({ text: e.target.value, inBar: false })}
                onBlur={() => editing && commit(editing.text)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" || e.key === "Tab") {
                    commit(editing.text);
                    go(e.key === "Enter" ? { r: active.r + 1, c: active.c } : { r: active.r, c: active.c + 1 }, false);
                    e.preventDefault();
                  } else if (e.key === "Escape") {
                    setEditing(null);
                    grid.current?.focus();
                  }
                }}
              />
            )}
            {!editing && (
              <div className="sht-selection-tools" style={{ left: view.left + view.w / 2, top: view.top + view.h - 44 }}>
                <span>{sheet.name}!{selectedRange}</span>
                <button onClick={(e) => { e.stopPropagation(); void quoteSelection(); }}><Icon name="chat" />{t("sheet.askFinx")}</button>
                <button onClick={(e) => { e.stopPropagation(); void copySelection(); }}><Icon name="copy" />{t("sheet.copy")}</button>
              </div>
            )}
          </div>
        </div>
      )}
      {note && (
        <div className={`fpn-note ${note.kind === "conflict" ? "warn" : ""}`} role="alert">
          <Icon name={note.kind === "conflict" ? "warn" : "lock"} />
          <span>{note.kind === "refused" ? t("sheet.refused", { reason: note.text }) : note.text}</span>
          {note.kind === "conflict" ? (
            <button className="btn sm" onClick={() => void save(true)}>{t("sheet.overwrite")}</button>
          ) : (
            <button className="btn sm" onClick={() => void openExcel()}>{t("sheet.openExcel")}</button>
          )}
          <button className="btn sm" onClick={() => setNote(null)}>{t("sheet.dismiss")}</button>
        </div>
      )}
      <div className="sht-tabs" role="tablist">
        {sheets.map((s) => (
          <button key={s.name} role="tab" aria-selected={s.name === sheetName} className={`sht-tab ${s.name === sheetName ? "on" : ""}`} onClick={() => {
            setSheetName(s.name);
            setSel({ anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 } });
            setLit(null);
          }}>
            {s.chart && <Icon name="grid" />}
            {s.name}
          </button>
        ))}
        <div className="sht-zoom">
          <button className="tb" aria-label={t("sheet.zoomOut")} onClick={() => setZoomTo(zoom / 1.1)}><Icon name="minus" /></button>
          <button className="sht-zoom-n" title={t("sheet.zoomReset")} onClick={() => setZoomTo(1)}>{Math.round(zoom * 100)}%</button>
          <button className="tb" aria-label={t("sheet.zoomIn")} onClick={() => setZoomTo(zoom * 1.1)}><Icon name="plus" /></button>
        </div>
      </div>
    </div>
  );
}

/** What the last edit moved: its key outputs, how many cells, what Excel recalculates. */
function ImpactBar({ impact, onClose, onJump }: { impact: Impact; onClose: () => void; onJump: (sheet: string, cell: string) => void }) {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const pct = (a?: unknown, b?: unknown) => {
    const x = (a as { value?: unknown } | undefined)?.value;
    const y = (b as { value?: unknown } | undefined)?.value;
    return typeof x === "number" && typeof y === "number" && x !== 0 ? ` (${((y - x) / Math.abs(x)) * 100 >= 0 ? "+" : ""}${(((y - x) / Math.abs(x)) * 100).toFixed(1)}%)` : "";
  };
  return (
    <div className={`sht-impact ${open ? "open" : ""}`} role="status">
      <div className="sht-impact-summary">
        <button className="sht-impact-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}><Icon name={open ? "chevD" : "chevR"} /><b>{t("sheet.impact")}</b></button>
        <span>{t("sheet.edited", { count: impact.edited.length })}</span>
        <span>{t("sheet.affected", { count: impact.affected_count })}</span>
        {(impact.needs_excel?.length ?? 0) > 0 && <span>{t("sheet.needsExcel", { count: impact.needs_excel!.length })}</span>}
        {impact.iterations != null && <span>{t("sheet.iterated", { count: impact.iterations })}</span>}
        {!impact.converged && <span className="bad">{t("sheet.notConverged")}</span>}
        <button className="tb" aria-label={t("sheet.dismiss")} onClick={onClose}><Icon name="x" /></button>
      </div>
      {open && (
        <div className="sht-impact-body">
          <ImpactTable title={t("sheet.changes")} rows={impact.edited} onJump={onJump} pct={pct} />
          {(impact.key_outputs?.length ?? 0) > 0 && <ImpactTable title={t("sheet.outputs")} rows={impact.key_outputs!} onJump={onJump} pct={pct} />}
          {impact.calc_unavailable && <p>{t("sheet.calcUnavailable", { reason: impact.calc_unavailable })}</p>}
        </div>
      )}
    </div>
  );
}

function ImpactTable({ title, rows, onJump, pct }: { title: string; rows: Impact["edited"]; onJump: (sheet: string, cell: string) => void; pct: (a?: unknown, b?: unknown) => string }) {
  return (
    <div className="sht-impact-table">
      <b>{title}</b>
      {rows.slice(0, 5).map((row) => (
        <button key={`${row.sheet}!${row.cell}`} onClick={() => onJump(row.sheet, row.cell)}>
          <code>{row.sheet}!{row.cell}</code>
          <span>{row.label ?? ""}</span>
          <span>{row.before_text || "—"} → {row.after_text || "—"}{pct(row.before, row.after)}</span>
        </button>
      ))}
      {rows.length > 5 && <small>+{rows.length - 5}</small>}
    </div>
  );
}
