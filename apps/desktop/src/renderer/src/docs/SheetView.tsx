import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { baseName, type RpcClient } from "@finx/client";
import type { CellData, Impact, SheetInfo, SheetOp } from "@finx/protocol";
import { Icon } from "../icons";
import { isRpcKind } from "../rpcError";
import { errorText, useStore } from "../store";
import { openRef } from "../session/contentMenus";
import { addr, areaOf, colName, MAX_COLS, MAX_ROWS, onSheet, parseAddr, parseRange, rangeText, type Area, type Pos } from "./cellref";
import { useEditQueue } from "./sheet/editQueue";
import { useGeometry } from "./sheet/geometry";
import { ImpactBar } from "./sheet/ImpactBar";
import { editTextOf, inputOp, readable, readSizes, sizeKey, sizesOf, toMarkdown, toTsv, writeSizes, type Sizes } from "./sheet/model";
import { quoteToComposer, setDocInfo, setSheetViewing, type DocTab, type Jump } from "./state";

export { inputOp } from "./sheet/model";

// A workbook in the file panel (spreadsheet-design §8): a bar with the address and the formula,
// the grid, and the sheets underneath. Cells are read from finx by blocks of rows as they come
// into sight (doc/cells); edits go back as SheetOps (doc/apply) and come back with their impact,
// which the grid lights up. The agent's edits arrive as a new revision of the document.

type Sel = { anchor: Pos; focus: Pos };

const BLOCK = 100;
const HEAD_W = 44;
const HEAD_H = 22;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

type Cache = { key: string; cells: Map<string, CellData>; blocks: Set<number>; merges: Area[]; heights: Map<number, number> };

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
    const next = clampZoom(Math.round(z * 100) / 100);
    if (!el) return;
    const x = el.scrollLeft / zoomRef.current;
    const y = el.scrollTop / zoomRef.current;
    zoomRef.current = next;
    setZoom(next);
    requestAnimationFrame(() => {
      el.scrollLeft = x * next;
      el.scrollTop = y * next;
      // The browser keeps the scroll within the new size: read back where it is.
      measureView();
    });
  };
  const grid = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, w: 800, h: 600 });
  /** What is in sight, in the grid's own pixels (zoom undone). */
  const measureView = () => {
    const el = scroller.current;
    const z = zoomRef.current;
    if (el) setView({ top: el.scrollTop / z, left: el.scrollLeft / z, w: el.clientWidth / z, h: el.clientHeight / z });
  };
  /** The sheet grows as far as the selection goes, with room beyond. */
  const reach = (r: number, c: number) => setExtent((x) => ({ rows: Math.max(x.rows, r + 20), cols: Math.max(x.cols, c + 5) }));
  const logActivity = (item: Activity) => setActivity((items) => [item, ...items].slice(0, 20));
  const cache = useRef<Cache>({ key: "", cells: new Map(), blocks: new Set(), merges: [], heights: new Map() });
  const { busy, enqueue, idle, made, revision, takeOwn } = useEditQueue(session, info);

  // ── the sheet's shape ──
  const used = parseRange(sheet?.used ?? "A1") ?? { r1: 1, c1: 1, r2: 1, c2: 1 };
  const nCols = Math.min(MAX_COLS, Math.max(used.c2 + 5, extent.cols, 26));
  const nRows = Math.min(MAX_ROWS, Math.max(used.r2 + 50, extent.rows, 100));
  // Widths and heights dragged here, by sheet: how the grid shows them, not written to the file.
  const [sized, setSized] = useState<Sizes>(() => readSizes(docId));
  const sizedDoc = useRef(docId);
  useEffect(() => {
    if (sizedDoc.current !== docId) {
      sizedDoc.current = docId;
      setSized(readSizes(docId));
      return;
    }
    writeSizes(docId, sized);
  }, [docId, sized]);
  const colSizes = useMemo(() => sizesOf(sized.cols, sheetName), [sized.cols, sheetName]);
  const rowSizes = useMemo(() => sizesOf(sized.rows, sheetName), [sized.rows, sheetName]);
  const c0 = cache.current;
  const { widths, colLeft, rowY, rowAt, colAt } = useGeometry({ sheet, nCols, nRows, colSizes, rowSizes, heights: c0.heights, heightsStamp: `${c0.key}:${c0.heights.size}` });
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
      cache.current = { key, cells: new Map(), blocks: new Set(), merges: [], heights: old.key.startsWith(`${docId}:${sheetName}:`) ? new Map(old.heights) : new Map() };
      const first = Math.floor(Math.max(0, rowAt(view.top) - 1) / BLOCK);
      const last = Math.floor(rowAt(view.top + view.h) / BLOCK);
      void Promise.all(Array.from({ length: last - first + 1 }, (_, i) => load(first + i))).then(() => {
        if (!diff || cache.current.key !== key) return;
        const changed = new Set<string>();
        for (const [k, v] of cache.current.cells) if (old.cells.has(k) && old.cells.get(k)!.text !== v.text) changed.add(k);
        for (const k of old.cells.keys()) if (!cache.current.cells.has(k) && old.cells.get(k)!.text) changed.add(k);
        if (changed.size) {
          setLit({ edited: new Set(), affected: changed });
          const first = changed.values().next().value as string | undefined;
          setAgentNotice({ count: changed.size, first });
          logActivity({ revision: info.revision, title: t("sheet.agentChanged", { count: changed.size }) });
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docId, sheetName, info.revision, load, view.top, view.h, t],
  );

  // A new sheet, or a new revision (an edit here, or the agent's): read again.
  useEffect(() => {
    const mine = takeOwn(info.revision);
    const byAgent = !mine && cache.current.key.startsWith(`${docId}:${sheetName}:`);
    reread(byAgent);
    if (byAgent) setImpact(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, sheetName, info.revision]);

  useEffect(() => {
    setAgentNotice(null);
    setImpact(null);
    setEditing(null);
  }, [docId, sheetName]);

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
    measureView();
    const ro = new ResizeObserver(measureView);
    ro.observe(el);
    // Pinch on a trackpad (and ⌘ with the wheel): the grid zooms about the pointer, as in Excel.
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const old = zoomRef.current;
      const next = clampZoom(old * Math.exp(-e.deltaY * 0.006));
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
        measureView();
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
  const selected = areaOf(sel.anchor, sel.focus);
  const selectedRange = rangeText(selected);
  const editable = !sheet?.protected && !!info.capabilities.includes("edit_values");
  const editText = editTextOf(activeCell);
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
    reach(range.r2, range.c2);
    setSel({ anchor: { r: range.r1, c: range.c1 }, focus: { r: range.r2, c: range.c2 } });
    setLit({ edited: new Set(), affected: new Set([addr({ r: range.r1, c: range.c1 })]) });
  }, [jump?.seq, docId]);

  const apply = async (ops: SheetOp[]) => {
    if (!sheet || !editable) return;
    if (!info.capabilities.includes("edit_formulas") && ops.some((op) => op.op === "set_formula")) {
      setNote({ text: t("sheet.csvNoFormula"), kind: "refused" });
      return;
    }
    return enqueue(async () => {
      try {
        const r = await rpc.request("doc/apply", { session_id: session, doc_id: docId, ops, base_revision: revision() });
        made(r);
        setNote(null);
        setLit({ edited: new Set(r.impact.edited.filter((e) => e.sheet === sheet.name).map((e) => e.cell)), affected: new Set(onSheet(r.impact.affected ?? [], sheet.name)) });
        setImpact(r.impact.affected_count || r.impact.key_outputs?.length || r.impact.needs_excel?.length ? { impact: r.impact, byAgent: false } : null);
        logActivity({ revision: r.revision, title: t("sheet.youChanged", { count: r.impact.edited.length }), impact: r.impact });
        setAgentNotice(null);
      } catch (e) {
        if (isRpcKind(e, "doc_refused")) setNote({ text: e.message, kind: "refused" });
        else st.show(errorText(e), undefined, true);
      }
    });
  };

  // One commit per edit: Enter commits, then the editor's blur would again.
  const committing = useRef(false);
  const commit = (text: string): Promise<void> => {
    if (committing.current) return Promise.resolve();
    committing.current = true;
    queueMicrotask(() => (committing.current = false));
    setEditing(null);
    const cell = addr(active);
    const before = editText;
    const done = text !== before && sheet ? apply([inputOp(sheet.name, cell, text)]) : Promise.resolve();
    grid.current?.focus();
    return done;
  };

  const history = (which: "doc/undo" | "doc/redo") =>
    enqueue(async () => {
      try {
        const r = await rpc.request(which, { session_id: session, doc_id: docId });
        made(r);
        setImpact(null);
        setLit(null);
        logActivity({ revision: r.revision, title: t(which === "doc/undo" ? "sheet.undone" : "sheet.redone"), impact: r.impact });
      } catch (e) {
        st.show(errorText(e), undefined, true);
      }
    });

  const recalc = (circularOnly: boolean) =>
    enqueue(async () => {
      try {
        const result = await rpc.request("doc/recalc", { session_id: session, doc_id: docId, circular_only: circularOnly });
        setImpact({ impact: result.impact, byAgent: false });
        setLit({ edited: new Set(), affected: new Set(onSheet([...(result.impact.affected ?? []), ...(result.impact.needs_excel ?? [])], sheetName)) });
        st.show(t(result.impact.affected_count || result.impact.needs_excel?.length ? "sheet.recalcCompared" : "sheet.recalcMatches"));
      } catch (error) { st.show(errorText(error), undefined, true); }
    });

  /** Saves in place (over a change on disk with `force`), or to `path` (save as). */
  const save = async (force = false, path?: string) => {
    // What is typed and on its way is saved with the rest.
    await idle();
    try {
      const next = await rpc.request("doc/save", { session_id: session, doc_id: docId, force, ...(path ? { path } : {}) });
      setDocInfo(session, next);
      if (!path) setNote(null);
      st.show(path ? t("sheet.savedAs", { name: baseName(path) }) : t("sheet.saved"));
      return true;
    } catch (e) {
      if (!path && isRpcKind(e, "doc_conflict")) setNote({ text: t("sheet.conflict"), kind: "conflict" });
      else st.show(errorText(e), undefined, true);
      return false;
    }
  };

  const saveAs = async () => {
    const path = window.finx ? await window.finx.pickSaveFile(info.path) : window.prompt(t("sheet.saveAsPrompt"), info.path);
    if (path) await save(false, path);
  };

  // ⌘S / ⌘⇧S save the workbook in view wherever the focus is in the window, even mid-edit:
  // the cell being typed is committed first, so what is saved is what is shown.
  const saveKey = useRef<(e: KeyboardEvent) => void>(() => {});
  saveKey.current = (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || (e.metaKey && e.ctrlKey) || e.key.toLowerCase() !== "s") return;
    if (!activeView || !root.current?.checkVisibility()) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    void (async () => {
      if (editing) await commit(editing.text);
      if (e.shiftKey) await saveAs();
      else if (info.dirty || editing) await save();
    })();
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => saveKey.current(e);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const openExcel = async () => {
    if (info.dirty && !(await save())) return;
    void openRef(st, { path: info.path, rel: null, kind: "file" }, undefined, "system");
  };

  const cellsInSelection = async () => {
    if (!sheet) throw new Error(t("sheet.empty"));
    return rpc.request("doc/cells", { session_id: session, doc_id: docId, sheet: sheet.name, range: selectedRange });
  };

  /** The selection's shown text, by address, as read from finx (cells out of sight included). */
  const selectionText = async () => {
    const result = await cellsInSelection();
    const values = new Map(result.cells.map((cell) => [cell.cell, cell.text]));
    return (cell: string) => values.get(cell);
  };

  const copySelection = async () => {
    try {
      await navigator.clipboard.writeText(toTsv(selected, await selectionText()));
      st.show(t("sheet.copied"));
    } catch (error) { st.show(errorText(error), undefined, true); }
  };

  const quoteSelection = async () => {
    if (!sheet) return;
    const count = (selected.r2 - selected.r1 + 1) * (selected.c2 - selected.c1 + 1);
    let text = t("sheet.selectionSummary", { range: `${sheet.name}!${selectedRange}`, count });
    if (count <= 200) {
      try {
        text = `${sheet.name}!${selectedRange}\n\n${toMarkdown(selected, await selectionText())}`;
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
    reach(q.r, q.c);
    setSel((s) => (extend ? { anchor: s.anchor, focus: q } : { anchor: q, focus: q }));
    requestAnimationFrame(() => reveal(q));
  };
  const jumpCell = (targetSheet: string, cell: string) => {
    const p = parseAddr(cell);
    if (!p) return;
    setSheetName(targetSheet);
    reach(p.r, p.c);
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
      void apply([{ op: "clear", sheet: sheet.name, range: selectedRange }]);
    } else if (mod && e.key.toLowerCase() === "z") {
      void history(e.shiftKey ? "doc/redo" : "doc/undo");
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

  // Once per drawing, not per cell.
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
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
        color: readable(d?.look?.color, dark),
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
        next[kind].set(sizeKey(sheetName, n), size);
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

  const multi = g.r1 !== g.r2 || g.c1 !== g.c2;
  const selBox = (() => {
    const m = mergeAt(active.r, active.c);
    const box = m && g.r1 === g.r2 && g.c1 === g.c2 ? m : g;
    const w = colLeft[box.c2 + 1] - colLeft[box.c1];
    const h = rowY(box.r2 + 1) - rowY(box.r1);
    const p = place(box.r1, box.c1, w, h);
    if (!multi) return { ...p, zIndex: 5 };
    // Multi-cell range: leave the active cell untinted (like Excel) instead of drawing a second box over it.
    const x1 = colLeft[active.c] - colLeft[box.c1];
    const y1 = rowY(active.r) - rowY(box.r1);
    const x2 = x1 + widths[active.c];
    const y2 = y1 + rowY(active.r + 1) - rowY(active.r);
    const hole = `polygon(evenodd, 0 0, ${w}px 0, ${w}px ${h}px, 0 ${h}px, 0 0, ${x1}px ${y1}px, ${x2}px ${y1}px, ${x2}px ${y2}px, ${x1}px ${y2}px, ${x1}px ${y1}px)`;
    return { ...p, zIndex: 5, "--sht-hole": hole } as CSSProperties;
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
    <div ref={root} className="sht" onKeyDown={onKey}>
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
          <button className="tb" title={t("sheet.undo")} aria-label={t("sheet.undo")} disabled={!editable || busy} onClick={() => void history("doc/undo")}><Icon name="undo" /></button>
          <button className="tb sht-redo" title={t("sheet.redo")} aria-label={t("sheet.redo")} disabled={!editable || busy} onClick={() => void history("doc/redo")}><Icon name="undo" /></button>
          <button className={`tb ${showHistory ? "on" : ""}`} title={t("sheet.history")} aria-label={t("sheet.history")} onClick={() => setShowHistory((v) => !v)}><Icon name="clock" /></button>
          {info.capabilities.includes("calc") && <>
            <button className="tb" title={t("sheet.recalcAll")} aria-label={t("sheet.recalcAll")} disabled={busy} onClick={() => void recalc(false)}><Icon name="recalc" /></button>
            <button className="tb" title={t("sheet.recalcCycles")} aria-label={t("sheet.recalcCycles")} disabled={busy} onClick={() => void recalc(true)}><Icon name="cycles" /></button>
          </>}
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
          onScroll={measureView}
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
            <div className={`sht-sel ${multi ? "multi" : ""}`} style={selBox} />
            {!multi && <div className="sht-active" style={{ ...activeBox, zIndex: 5 }} />}
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
              <div className="sht-selection-tools" onMouseDown={(e) => e.stopPropagation()} style={{ left: view.left + view.w / 2, top: view.top + view.h - 44 / zoom, transform: `translateX(-50%) scale(${1 / zoom})`, transformOrigin: "top center" }}>
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
