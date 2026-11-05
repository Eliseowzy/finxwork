import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { baseName, type RpcClient } from "@finx/client";
import type { CellData, DocApplyResult, FoundCell, Impact, SheetInfo, SheetOp } from "@finx/protocol";
import { Icon, type IconName } from "../icons";
import { isRpcKind } from "../rpcError";
import { errorText, useStore } from "../store";
import { openRef } from "../session/contentMenus";
import type { MenuItem } from "../../../shared/bridge";
import { addr, areaOf, colName, MAX_COLS, MAX_ROWS, onSheet, parseAddr, parseRange, rangeText, type Area, type Pos } from "./cellref";
import { useEditQueue } from "./sheet/editQueue";
import { useGeometry } from "./sheet/geometry";
import { ImpactBar } from "./sheet/ImpactBar";
import { decimalsOf, editTextOf, inputOp, isHardcoded, lensAt, lensText, MAX_PASTE, parseTsv, pasteOps, readable, readLenses, readSizes, selectionStats, sizeKey, sizesOf, statText, toMarkdown, toTsv, UNITS, withLens, writeLenses, writeSizes, type Lens, type SelectionStats, type Sizes, type Unit } from "./sheet/model";
import { TraceBar, type Trace } from "./sheet/TraceBar";
import { quoteToComposer, setDocInfo, setSheetViewing, type DocTab, type Jump } from "./state";

export { inputOp } from "./sheet/model";

// A workbook in the file panel (spreadsheet-design §8): a bar with the address and the formula,
// the grid, and the sheets underneath. Cells are read from finx by blocks of rows as they come
// into sight (doc/cells); edits go back as SheetOps (doc/apply) and come back with their impact,
// which the grid lights up. The agent's edits arrive as a new revision of the document.

/** A selection: from `anchor` to `focus`; `at`, when set, the active cell Enter and Tab have moved to inside it. */
type Sel = { anchor: Pos; focus: Pos; at?: Pos };

const BLOCK = 100;
const HEAD_W = 44;
const HEAD_H = 22;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

type Cache = { key: string; cells: Map<string, CellData>; blocks: Set<number>; merges: Area[]; heights: Map<number, number> };

type Activity = { revision: number; title: string; impact?: Impact };

export function SheetView({ rpc, session, tab, jump, activeView = true }: { rpc: RpcClient; session: string; tab: DocTab; jump?: Jump | null; activeView?: boolean }) {
  const { t, i18n } = useTranslation("session");
  const st = useStore();
  const info = tab.info;
  const docId = info.doc_id;
  const sheets = (info.sheets ?? []).filter((s) => !s.hidden);
  const [sheetName, setSheetName] = useState(() => sheets.find((s) => !s.chart)?.name ?? sheets[0]?.name ?? "");
  const sheet: SheetInfo | undefined = (info.sheets ?? []).find((s) => s.name === sheetName);
  const [sel, setSel] = useState<Sel>({ anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 } });
  const [editing, setEditing] = useState<{ text: string; inBar: boolean } | null>(null);
  // Cells lit up: what the agent changed (till dismissed), or what one of your edits changed downstream (till you move on). Your own edits are not marked, as in Excel.
  const [lit, setLit] = useState<{ cells: Set<string>; mine?: boolean } | null>(null);
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
          setLit({ cells: changed });
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

  // The file changed on disk and finx was asked for it again (files/state refreshDoc): read it
  // again, as it may hold Excel's changes; a sheet that is gone gives way to the first one.
  const token = useRef(tab.token);
  useEffect(() => {
    if (token.current === tab.token) return;
    token.current = tab.token;
    if (!sheet && sheets.length) setSheetName(sheets.find((x) => !x.chart)?.name ?? sheets[0].name);
    else reread(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.token]);

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
  // The active cell is where the selection began, as in Excel; the focus is the end that moves.
  const active = sel.at ?? sel.anchor;
  const activeCell = cache.current.cells.get(addr(active));
  const selected = areaOf(sel.anchor, sel.focus);
  const selectedRange = rangeText(selected);
  const editable = !sheet?.protected && !!info.capabilities.includes("edit_values");
  const editText = editTextOf(activeCell);
  const shown = (p: Pos) => cache.current.cells.get(addr(p));

  // The status bar's figures for the selection, as in Excel; read from finx, so cells out of sight count too.
  const [stats, setStats] = useState<SelectionStats | null>(null);
  // The selection last read, and whether anything was in it (a single cell has no figures but may hold a value).
  const [statsOf, setStatsOf] = useState({ key: "", any: false });
  const statsKey = `${sheetName}!${selectedRange}`;
  const inUse = { r1: Math.max(selected.r1, used.r1), c1: Math.max(selected.c1, used.c1), r2: Math.min(selected.r2, used.r2), c2: Math.min(selected.c2, used.c2) };
  const inUseSize = inUse.r1 > inUse.r2 || inUse.c1 > inUse.c2 ? 0 : (inUse.r2 - inUse.r1 + 1) * (inUse.c2 - inUse.c1 + 1);
  // Only a selection with something in it is offered to the agent; one too large to count is taken to have.
  const selectionFilled = inUseSize > STATS_MAX_CELLS || (inUseSize > 0 && statsOf.key === statsKey && statsOf.any);
  useEffect(() => {
    if (!sheet || sheet.chart || inUseSize === 0 || inUseSize > STATS_MAX_CELLS) return setStats(null);
    let gone = false;
    const timer = setTimeout(() => {
      rpc.request("doc/cells", { session_id: session, doc_id: docId, sheet: sheet.name, range: rangeText(inUse) })
        .then((r) => {
          if (gone) return;
          setStats(selectionStats(r.cells, selected));
          setStatsOf({ key: statsKey, any: r.cells.some((c) => !!c.text || !!c.value) });
        })
        .catch(() => !gone && setStats(null));
    }, 80);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [docId, sheetName, selectedRange, sheet?.used, info.revision]);

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
    setLit({ cells: new Set([addr({ r: range.r1, c: range.c1 })]) });
  }, [jump?.seq, docId]);

  const apply = async (ops: SheetOp[]) => {
    if (!sheet || !editable) return;
    if (!info.capabilities.includes("edit_formulas") && ops.some((op) => op.op === "set_formula")) {
      setNote({ text: t("sheet.csvNoFormula"), kind: "refused" });
      return;
    }
    return edited(() => rpc.request("doc/apply", { session_id: session, doc_id: docId, ops, base_revision: revision() }));
  };

  /** An edit on its way, after the ones before it; what it changed lights up, a refusal says why. */
  const edited = (send: () => Promise<DocApplyResult>) => {
    if (!sheet) return;
    return enqueue(async () => {
      try {
        const r = await send();
        made(r);
        setNote(null);
        setLit({ cells: new Set(onSheet(r.impact.affected ?? [], sheet.name)), mine: true });
        setImpact(r.impact.affected_count || r.impact.key_outputs?.length || r.impact.needs_excel?.length ? { impact: r.impact, byAgent: false } : null);
        logActivity({ revision: r.revision, title: t("sheet.youChanged", { count: r.impact.edited.length }), impact: r.impact });
        setAgentNotice(null);
      } catch (e) {
        if (isRpcKind(e, "doc_refused")) setNote({ text: e.message, kind: "refused" });
        else st.show(errorText(e), undefined, true);
      }
    });
  };

  /** Excel's ⌘D / ⌘R: the selection's first row (or column) across it; one cell takes the one above (or left). */
  const fill = (direction: "down" | "right") => {
    if (!sheet || !editable) return;
    const g = selected;
    const range = g.r1 === g.r2 && g.c1 === g.c2
      ? direction === "down" ? (g.r1 > 1 ? rangeText({ ...g, r1: g.r1 - 1 }) : null) : g.c1 > 1 ? rangeText({ ...g, c1: g.c1 - 1 }) : null
      : rangeText(g);
    if (!range) return;
    void edited(() => rpc.request("doc/fill", { session_id: session, doc_id: docId, sheet: sheet.name, range, direction, base_revision: revision() }));
  };

  /** The fill handle being dragged: the cells it would fill to, and what the farthest would show. */
  const [filling, setFilling] = useState<{ to: Area; tip: string | null } | null>(null);
  const fillSeq = useRef(0);

  /** Dragging Excel's fill handle: the drag adds rows or columns on the side it goes furthest past; inside the source, it takes them back. */
  const dragFill = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!sheet || !editable || e.button !== 0) return;
    const from = selected;
    const name = sheet.name;
    const anchor = sel.anchor;
    const same = (a: Area, b: Area) => a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;
    const grows = (to: Area) => to.r1 < from.r1 || to.r2 > from.r2 || to.c1 < from.c1 || to.c2 > from.c2;
    const switched = (ev: MouseEvent) => ev.altKey || ev.ctrlKey;
    const targetOf = (q: Pos): Area => {
      const down = q.r - from.r2, up = from.r1 - q.r, right = q.c - from.c2, left = from.c1 - q.c;
      const v = Math.max(down, up), h = Math.max(right, left);
      if (v <= 0 && h <= 0) {
        if (q.r < from.r2 && from.r2 - q.r >= from.c2 - q.c) return { ...from, r2: q.r };
        if (q.c < from.c2) return { ...from, c2: q.c };
        return from;
      }
      if (v >= h) return down > 0 ? { ...from, r2: q.r } : { ...from, r1: q.r };
      return right > 0 ? { ...from, c2: q.c } : { ...from, c1: q.c };
    };
    // The cell whose value the tip shows: the farthest the drag reaches, in the source's first line.
    const farthest = (to: Area) =>
      to.r2 > from.r2 ? addr({ r: to.r2, c: from.c1 }) : to.r1 < from.r1 ? addr({ r: to.r1, c: from.c1 }) : to.c2 > from.c2 ? addr({ r: from.r1, c: to.c2 }) : addr({ r: from.r1, c: to.c1 });
    let to = from;
    let held = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const preview = () => {
      clearTimeout(timer);
      const mine = ++fillSeq.current;
      if (!grows(to)) return;
      const target = to;
      timer = setTimeout(() => {
        rpc.request("doc/autofill", { session_id: session, doc_id: docId, sheet: name, source: rangeText(from), target: rangeText(target), switch: held, preview: true })
          .then((r) => {
            if (mine !== fillSeq.current) return;
            const shown = r.impact.edited.find((x) => x.sheet === name && x.cell === farthest(target))?.after_text;
            setFilling((f) => f && { ...f, tip: shown || null });
          })
          .catch(() => {});
      }, 120);
    };
    const move = (ev: MouseEvent) => {
      const q = pick(ev as unknown as React.MouseEvent);
      if (!q) return;
      const next = targetOf(q);
      if (same(next, to) && switched(ev) === held) return;
      to = next;
      held = switched(ev);
      setFilling({ to, tip: null });
      preview();
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      clearTimeout(timer);
      fillSeq.current++;
      document.body.style.cursor = "";
      setFilling(null);
      if (same(to, from)) return;
      const target = to;
      const corner = { r: anchor.r === target.r1 ? target.r2 : target.r1, c: anchor.c === target.c1 ? target.c2 : target.c1 };
      setSel({ anchor, focus: corner });
      if (grows(target)) {
        void edited(() => rpc.request("doc/autofill", { session_id: session, doc_id: docId, sheet: name, source: rangeText(from), target: rangeText(target), switch: switched(ev), base_revision: revision() }));
      } else {
        // Taken back inside the source: the rows (or columns) given up are emptied.
        const gone = target.r2 < from.r2 ? { ...from, r1: target.r2 + 1 } : { ...from, c1: target.c2 + 1 };
        void apply([{ op: "clear", sheet: name, range: rangeText(gone) }]);
      }
      grid.current?.focus();
    };
    document.body.style.cursor = "crosshair";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** A paste: the clipboard's text, cell by cell from the selection's top-left, as one edit; values only, as typed. */
  const paste = (text: string) => {
    if (!sheet || !editable) return;
    const rows = parseTsv(text);
    const ops = pasteOps(sheet.name, { r: selected.r1, c: selected.c1 }, rows);
    if (!ops) return void (rows.length && st.show(t("sheet.pasteTooBig", { max: MAX_PASTE.toLocaleString() }), undefined, true));
    const width = Math.max(...rows.map((row) => row.length));
    setSel({ anchor: { r: selected.r1, c: selected.c1 }, focus: { r: selected.r1 + rows.length - 1, c: selected.c1 + width - 1 } });
    void apply(ops);
  };

  // ── tracing (Excel's 追踪引用单元格 / 追踪从属单元格) ──
  const [trace, setTrace] = useState<Trace | null>(null);
  /** From the active cell, one step out; again from the same cell the same way, one step further. */
  const traceFrom = async (direction: "up" | "down", again?: Trace) => {
    if (!sheet) return;
    const cell = again?.cell ?? addr(active);
    const from = again?.sheet ?? sheet.name;
    const same = trace && trace.sheet === from && trace.cell === cell && trace.direction === direction;
    const depth = again ? again.depth : same ? Math.min(10, trace.depth + 1) : 1;
    try {
      const r = await rpc.request("doc/trace", { session_id: session, doc_id: docId, sheet: from, cell, direction, depth });
      setTrace({ sheet: from, cell, direction, depth, cells: r.cells, more: !!r.more });
    } catch (e) {
      st.show(errorText(e), undefined, true);
    }
  };
  // Formulas changed: the trace is worked out again, as far out as it went.
  useEffect(() => {
    if (trace) void traceFrom(trace.direction, trace);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.revision]);

  // ── showing formulas (Excel's 显示公式, ⌃`) ──
  const [showFormulas, setShowFormulas] = useState(false);

  // ── display units (spreadsheet-design §8.8): how numbers show here, never written to the file ──
  const [lenses, setLenses] = useState<Record<string, Lens[]>>(() => readLenses(docId));
  const sheetLenses = lenses[sheetName];
  const setSheetLenses = (next: Lens[]) => {
    const all = { ...lenses, [sheetName]: next };
    setLenses(all);
    writeLenses(docId, all);
    if (next.length && !localStorage.getItem("finx.sheet.lensTold")) {
      localStorage.setItem("finx.sheet.lensTold", "1");
      st.show(t("sheet.lensFirst"));
    }
  };
  /** One cell selected stands for its whole column, as a unit is a column's. */
  const lensArea = () => (selected.r1 === selected.r2 && selected.c1 === selected.c2 ? { r1: 1, c1: selected.c1, r2: MAX_ROWS, c2: selected.c1 } : selected);
  const activeLens = lensAt(sheetLenses, active.r, active.c);

  // ── finding (⌘F, as Excel's 查找) ──
  const [find, setFind] = useState<{ query: string; hits: FoundCell[] | null; at: number; more: boolean } | null>(null);
  const findBox = useRef<HTMLInputElement>(null);
  const openFind = () => {
    setFind((f) => f ?? { query: "", hits: null, at: 0, more: false });
    setTimeout(() => (findBox.current?.focus(), findBox.current?.select()));
  };
  useEffect(() => {
    const onFind = () => root.current?.contains(document.activeElement) && openFind();
    window.addEventListener("finx:find", onFind);
    return () => window.removeEventListener("finx:find", onFind);
  }, []);
  const findNext = async (back: boolean) => {
    if (!find || !find.query.trim()) return;
    let { hits, at } = find;
    if (!hits) {
      try {
        const r = await rpc.request("doc/find", { session_id: session, doc_id: docId, query: find.query.trim(), limit: 500 });
        hits = r.cells;
        at = 0;
        setFind({ ...find, hits, at, more: !!r.more });
      } catch (e) {
        return st.show(errorText(e), undefined, true);
      }
    } else if (hits.length) {
      at = (at + (back ? hits.length - 1 : 1)) % hits.length;
      setFind({ ...find, at });
    }
    const hit = hits[at];
    if (hit) jumpCell(hit.sheet, hit.cell);
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

  /** After an undo or redo, as in Excel: the cells it changed are selected, on their sheet, and brought into sight. */
  const selectChanged = (changed: { sheet: string; cell: string }[]) => {
    const on = changed.some((x) => x.sheet === sheetName) ? sheetName : changed[0]?.sheet;
    const at = changed.filter((x) => x.sheet === on).map((x) => parseAddr(x.cell)).filter((p): p is Pos => !!p);
    if (!on || !at.length) return;
    const top = { r: Math.min(...at.map((p) => p.r)), c: Math.min(...at.map((p) => p.c)) };
    const bottom = { r: Math.max(...at.map((p) => p.r)), c: Math.max(...at.map((p) => p.c)) };
    if (on !== sheetName) setSheetName(on);
    reach(bottom.r, bottom.c);
    setSel({ anchor: top, focus: bottom });
    requestAnimationFrame(() => reveal(top));
  };

  const history = (which: "doc/undo" | "doc/redo") =>
    enqueue(async () => {
      try {
        const r = await rpc.request(which, { session_id: session, doc_id: docId });
        made(r);
        setImpact(null);
        setLit(null);
        selectChanged(r.impact.edited);
        logActivity({ revision: r.revision, title: t(which === "doc/undo" ? "sheet.undone" : "sheet.redone"), impact: r.impact });
      } catch (e) {
        st.show(errorText(e), undefined, true);
      }
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

  /** ⌘X: the selection copied, then cleared (values only, as the grid copies). */
  const cutSelection = async () => {
    if (!sheet || !editable) return;
    const range = selectedRange;
    try {
      await navigator.clipboard.writeText(toTsv(selected, await selectionText()));
    } catch (error) { return st.show(errorText(error), undefined, true); }
    void apply([{ op: "clear", sheet: sheet.name, range }]);
  };

  /** Paste from the menu, where no paste event comes: the clipboard's text, read here. */
  const pasteClipboard = async () => {
    if (!editable) return;
    try {
      paste(await navigator.clipboard.readText());
    } catch (error) { st.show(errorText(error), undefined, true); }
  };

  /** Right-click (or ⌃-click, the menu key, ⇧F10) on the grid: what can be done to the selection, as Excel's cell menu. */
  const cellMenu = async () => {
    if (!sheet) return;
    const off = !editable;
    const single = selected.r1 === selected.r2 && selected.c1 === selected.c2;
    const items: MenuItem[] = [
      { id: "cut", label: t("sheet.cut"), accel: "CmdOrCtrl+X", enabled: !off },
      { id: "copy", label: t("sheet.copy"), accel: "CmdOrCtrl+C" },
      { id: "paste", label: t("sheet.paste"), accel: "CmdOrCtrl+V", enabled: !off },
      { separator: true },
      { id: "clear", label: t("sheet.clearContents"), enabled: !off },
      { id: "fillDown", label: t("sheet.fillDown"), accel: "CmdOrCtrl+D", enabled: !off && (!single || selected.r1 > 1) },
      { id: "fillRight", label: t("sheet.fillRight"), accel: "CmdOrCtrl+R", enabled: !off && (!single || selected.c1 > 1) },
      { separator: true },
      { id: "traceUp", label: t("sheet.traceUp"), accel: "CmdOrCtrl+[" },
      { id: "traceDown", label: t("sheet.traceDown"), accel: "CmdOrCtrl+]" },
      ...(trace ? [{ id: "traceOff", label: t("sheet.traceClear") }] : []),
      { id: "formulas", label: t("sheet.showFormulas"), accel: "Ctrl+`", checked: showFormulas },
      { separator: true },
      { id: "quote", label: t("sheet.askAgent"), accel: "CmdOrCtrl+L" },
      { id: "excel", label: t("sheet.openExcel"), accel: "Alt+CmdOrCtrl+E" },
    ];
    const id = await window.finx?.popupMenu(items);
    grid.current?.focus();
    switch (id) {
      case "cut": return void cutSelection();
      case "copy": return void copySelection();
      case "paste": return void pasteClipboard();
      case "clear": return void apply([{ op: "clear", sheet: sheet.name, range: selectedRange }]);
      case "fillDown": return fill("down");
      case "fillRight": return fill("right");
      case "traceUp": return void traceFrom("up");
      case "traceDown": return void traceFrom("down");
      case "traceOff": return setTrace(null);
      case "formulas": return setShowFormulas((v) => !v);
      case "quote": return void quoteSelection();
      case "excel": return void openExcel();
    }
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
    // What the person sees in a unit is said, so the agent does not take the values for what is shown (§8.8).
    const shownIn = lensAt(sheetLenses, selected.r1, selected.c1);
    if (shownIn && shownIn.unit !== 1) text += `\n\n${t("sheet.lensQuote", { unit: t(`sheet.unit${shownIn.unit}`) })}`;
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
    // Moving on puts out what your last edit lit downstream; what the agent changed stays till dismissed.
    setLit((l) => (l?.mine ? null : l));
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
  /** Enter (down) or Tab (across), back with ⇧: in a range the active cell goes round inside it and the range stays, as in Excel; else on to the next cell. */
  const advance = (down: boolean, back: boolean) => {
    const g = areaOf(sel.anchor, sel.focus);
    const d = back ? -1 : 1;
    if (g.r1 === g.r2 && g.c1 === g.c2) return go(down ? { r: active.r + d, c: active.c } : { r: active.r, c: active.c + d }, false);
    let { r, c } = active;
    if (down) {
      r += d;
      if (r > g.r2) (r = g.r1), (c = c + 1 > g.c2 ? g.c1 : c + 1);
      else if (r < g.r1) (r = g.r2), (c = c - 1 < g.c1 ? g.c2 : c - 1);
    } else {
      c += d;
      if (c > g.c2) (c = g.c1), (r = r + 1 > g.r2 ? g.r1 : r + 1);
      else if (c < g.c1) (c = g.c2), (r = r - 1 < g.r1 ? g.r2 : r - 1);
    }
    setSel((s) => ({ ...s, at: { r, c } }));
    setLit((l) => (l?.mine ? null : l));
    requestAnimationFrame(() => reveal({ r, c }));
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
      const from = e.shiftKey ? sel.focus : active;
      go(mod ? edge(from, dr, dc) : { r: from.r + dr, c: from.c + dc }, e.shiftKey);
    } else if (e.key === "Enter" || e.key === "Tab") {
      advance(e.key === "Enter", e.shiftKey);
    } else if (e.key === "F2") {
      editable && setEditing({ text: editText, inBar: false });
    } else if ((e.key === "Backspace" || e.key === "Delete") && sheet && editable) {
      void apply([{ op: "clear", sheet: sheet.name, range: selectedRange }]);
    } else if (mod && e.key.toLowerCase() === "z") {
      void history(e.shiftKey ? "doc/redo" : "doc/undo");
    } else if (mod && e.key.toLowerCase() === "c") {
      void copySelection();
    } else if (mod && e.key.toLowerCase() === "x") {
      void cutSelection();
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      void cellMenu();
    } else if (mod && e.key.toLowerCase() === "l") {
      void quoteSelection();
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === "d") {
      fill("down");
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === "r") {
      fill("right");
    } else if (mod && (e.key === "[" || e.code === "BracketLeft")) {
      void traceFrom("up");
    } else if (mod && (e.key === "]" || e.code === "BracketRight")) {
      void traceFrom("down");
    } else if (e.ctrlKey && (e.key === "`" || e.code === "Backquote")) {
      setShowFormulas((v) => !v);
    } else if (!mod && e.key.length === 1 && editable) {
      setEditing({ text: e.key, inBar: false });
    } else if (e.key === "Escape") {
      setLit(null);
      setTrace(null);
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
  const cellAt = (r: number, c: number) => cache.current.cells.get(addr({ r, c }));
  const traced = new Set(trace ? trace.cells.filter((x) => x.sheet === sheetName).map((x) => x.cell) : []);
  if (trace && trace.sheet === sheetName) traced.add(trace.cell);
  const found = new Set(find?.hits?.filter((x) => x.sheet === sheetName).map((x) => x.cell) ?? []);
  const unitName = (u: Unit) => t(`sheet.unit${u}`);
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
      const asFormula = showFormulas && !!d?.formula;
      const lens = lensAt(sheetLenses, a.r, a.c);
      const lensed = asFormula ? null : lensText(d, lens, i18n.language);
      const text = asFormula ? d!.formula! : (lensed ?? d?.text);
      const num = d?.value?.type === "number" && !asFormula;
      const hard = isHardcoded(cellAt, a.r, a.c);
      const align = asFormula ? "left" : (d?.look?.align ?? (num ? "right" : d?.value?.type === "bool" || d?.value?.type === "error" ? "center" : "left"));
      // Text runs on over empty cells to its right, as in Excel.
      let span = w;
      if (!m && text && align === "left" && !num) {
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
      const cls = ["sht-c", text ? "has" : "", lit?.cells.has(key) ? "lit" : "", m ? "merged" : "", traced.has(key) ? "traced" : "", found.has(key) ? "found" : "", hard ? "hard" : "", lensed !== null ? "lensed" : "", asFormula ? "asformula" : ""].join(" ");
      const title = lensed !== null ? t("sheet.lensTip", { raw: d!.text, shown: lensed, unit: unitName(lens!.unit) }) : hard ? t("sheet.hardcoded") : (d?.formula ?? undefined);
      cells.push(
        <div key={`${r}:${c}`} data-cell={key} className={cls} style={style} title={title}>
          {text && <span style={span > w ? { width: span, background: d?.look?.fill ? undefined : "var(--sht-bg)" } : undefined}>{text}</span>}
        </div>,
      );
    }
  }

  const heads: React.ReactNode[] = [];
  /** A column shown in a unit other than the file's: its header says which (§8.8). */
  function unitOfCol(c: number): Unit | null {
    const l = sheetLenses?.findLast((x) => c >= x.area.c1 && c <= x.area.c2 && x.unit !== 1);
    return l?.unit ?? null;
  }
  for (const c of colsShown) {
    if (!widths[c]) continue;
    const fc = c <= frozen.cols;
    const on = c >= g.c1 && c <= g.c2;
    heads.push(<div key={`h${c}`} className={`sht-h col ${on ? "on" : ""}`} style={{ left: (fc ? view.left : 0) + HEAD_W + colLeft[c], top: view.top, width: widths[c], height: HEAD_H, zIndex: fc ? 7 : 6 }} onMouseDown={(e) => {
      e.stopPropagation();
      setSel({ anchor: { r: 1, c }, focus: { r: Math.max(used.r2, 1), c } });
      grid.current?.focus();
    }}>{colName(c)}{unitOfCol(c) && <span className="sht-unit">{unitName(unitOfCol(c)!)}</span>}</div>);
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

  // Trace arrows, as Excel draws them: from the cell read to the formula reading it, a dot at
  // its start; an end on another sheet is a dashed stub to a sheet mark.
  const centre = (cell: string) => {
    const p = parseAddr(cell);
    if (!p) return null;
    const b = place(p.r, p.c, widths[p.c] ?? 0, rowY(p.r + 1) - rowY(p.r));
    return { x: (b.left as number) + (b.width as number) / 2, y: (b.top as number) + (b.height as number) / 2 };
  };
  const arrows: React.ReactNode[] = [];
  for (const x of trace?.cells ?? []) {
    if (!x.via || arrows.length >= 300) continue;
    const cut = x.via.lastIndexOf("!");
    const via = { sheet: x.via.slice(0, cut), cell: x.via.slice(cut + 1) };
    const [from, to] = trace!.direction === "up" ? [{ sheet: x.sheet, cell: x.cell }, via] : [via, { sheet: x.sheet, cell: x.cell }];
    const a = from.sheet === sheetName ? centre(from.cell) : null;
    const b = to.sheet === sheetName ? centre(to.cell) : null;
    const k = `${from.sheet}!${from.cell}>${to.sheet}!${to.cell}`;
    if (a && b) {
      arrows.push(<g key={k}><circle cx={a.x} cy={a.y} r={3} /><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} markerEnd="url(#sht-arrow)" /></g>);
    } else if (a || b) {
      // The other end is on another sheet: a stub up and to the left of the cell here.
      const p = (a ?? b)!;
      const q = { x: p.x - 28, y: p.y - 22 };
      arrows.push(
        <g key={k} className="off">
          {a ? <line x1={a.x} y1={a.y} x2={q.x} y2={q.y} markerEnd="url(#sht-arrow)" /> : <line x1={q.x} y1={q.y} x2={b!.x} y2={b!.y} markerEnd="url(#sht-arrow)" />}
          <rect x={q.x - 7} y={q.y - 12} width={14} height={11} rx={1.5} />
          <path d={`M${q.x - 7} ${q.y - 8.5}h14M${q.x - 2.5} ${q.y - 12}v11`} />
        </g>,
      );
    }
  }

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
    <div
      ref={root}
      className="sht"
      onKeyDown={onKey}
      onPaste={(e) => {
        if (editing || (e.target as HTMLElement).closest("input, textarea")) return;
        e.preventDefault();
        paste(e.clipboardData.getData("text/plain"));
      }}
    >
      <div className="sht-tools" role="toolbar" aria-label={t("sheet.tools")}>
        <div className="sht-group">
          <button className="tb" title={t("sheet.save")} aria-label={t("sheet.save")} disabled={!dirty} onClick={() => void save()}><Icon name="save" /></button>
          <button className="tb" title={t("sheet.undo")} aria-label={t("sheet.undo")} disabled={!editable || busy} onClick={() => void history("doc/undo")}><Icon name="undo" /></button>
          <button className="tb sht-redo" title={t("sheet.redo")} aria-label={t("sheet.redo")} disabled={!editable || busy} onClick={() => void history("doc/redo")}><Icon name="undo" /></button>
        </div>
        <span className="sht-sep" />
        <div className="sht-group">
          <Tool icon="tracePre" label={t("sheet.traceUp")} tip={t("sheet.traceUpTip")} on={trace?.direction === "up"} onClick={() => void traceFrom("up")} />
          <Tool icon="traceDep" label={t("sheet.traceDown")} tip={t("sheet.traceDownTip")} on={trace?.direction === "down"} onClick={() => void traceFrom("down")} />
          {trace && <Tool icon="traceOff" label={t("sheet.traceClear")} onClick={() => setTrace(null)} />}
          <Tool icon="fx" label={t("sheet.showFormulas")} tip={t("sheet.showFormulasTip")} on={showFormulas} onClick={() => setShowFormulas((v) => !v)} />
        </div>
        <span className="sht-sep" />
        <div className="sht-group sht-numfmt">
          <select className="sht-unitsel" aria-label={t("sheet.unit")} title={t("sheet.unitTip")} value={activeLens?.unit ?? 1} onChange={(e) => setSheetLenses(e.target.value === "reset" ? [] : withLens(sheetLenses ?? [], lensArea(), { unit: Number(e.target.value) as Unit }))}>
            {UNITS.map((u) => <option key={u} value={u}>{unitName(u)}</option>)}
            {/* Everything on the sheet back as the file shows it. */}
            {!!sheetLenses?.length && <option value="reset">{t("sheet.lensClear")}</option>}
          </select>
          <button className="tb sht-dec" title={t("sheet.decimalsMore")} aria-label={t("sheet.decimalsMore")} onClick={() => setSheetLenses(withLens(sheetLenses ?? [], lensArea(), { decimals: (had) => Math.min(10, (had ?? decimalsOf(activeCell?.text ?? "")) + 1) }))}>.00</button>
          <button className="tb sht-dec" title={t("sheet.decimalsLess")} aria-label={t("sheet.decimalsLess")} onClick={() => setSheetLenses(withLens(sheetLenses ?? [], lensArea(), { decimals: (had) => Math.max(0, (had ?? decimalsOf(activeCell?.text ?? "")) - 1) }))}>.0</button>
        </div>
        <div className="sht-tools-end">
          {busy && <span className="mini-spin" />}
          <span className={`fpn-state ${dirty ? "dirty" : ""}`}>{dirty ? t("sheet.unsaved") : ""}</span>
          <button className={`tb ${find ? "on" : ""}`} title={t("sheet.find")} aria-label={t("sheet.find")} onClick={() => (find ? setFind(null) : openFind())}><Icon name="search" /></button>
          <button className={`tb ${showHistory ? "on" : ""}`} title={t("sheet.history")} aria-label={t("sheet.history")} onClick={() => setShowHistory((v) => !v)}><Icon name="clock" /></button>
          <button className="tb" title={t("sheet.openInExcel")} aria-label={t("sheet.openInExcel")} onClick={() => void openExcel()}><Icon name="ext" /></button>
        </div>
      </div>
      <div className="sht-bar">
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
        {activeLens && activeCell?.value?.type === "number" && <span className="sht-raw" title={t("sheet.rawTip")}>{editing ? t("sheet.rawInput") : t("sheet.raw")}</span>}
      </div>
      {find && (
        <form className="dcp-find sht-find" onSubmit={(e) => e.preventDefault()}>
          <Icon name="search" />
          <input
            ref={findBox}
            value={find.query}
            placeholder={t("sheet.findPlaceholder")}
            onChange={(e) => setFind({ query: e.target.value, hits: null, at: 0, more: false })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.preventDefault(), void findNext(e.shiftKey));
              else if (e.key === "Escape") (setFind(null), grid.current?.focus());
            }}
          />
          {find.hits && <span className="dcp-count">{find.hits.length ? `${find.at + 1}/${find.hits.length}${find.more ? "+" : ""}` : t("sheet.findNone")}</span>}
          <button type="button" className="tb" aria-label={t("sheet.dismiss")} onClick={() => (setFind(null), grid.current?.focus())}><Icon name="x" /></button>
        </form>
      )}
      {trace && <TraceBar trace={trace} onJump={jumpCell} onMore={() => void traceFrom(trace.direction)} onClose={() => setTrace(null)} />}
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
      {impact && <ImpactBar impact={impact.impact} onClose={() => (setImpact(null), setLit((l) => (l?.mine ? null : l)))} onJump={jumpCell} />}
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
              // A right-click (⌃-click on a Mac) keeps a selection it lands in, as Excel does, and drags nothing; the menu comes on contextmenu.
              if (e.button === 2 || (e.button === 0 && e.ctrlKey && window.finx?.platform === "mac")) {
                const inside = p.r >= selected.r1 && p.r <= selected.r2 && p.c >= selected.c1 && p.c <= selected.c2;
                if (!inside) go(p, false);
                grid.current?.focus();
                return;
              }
              if (e.button !== 0) return;
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
            onContextMenu={(e) => {
              e.preventDefault();
              if (editing) return;
              void cellMenu();
            }}
          >
            <div className="sht-corner" style={{ left: view.left, top: view.top, width: HEAD_W, height: HEAD_H }} onMouseDown={(e) => {
              e.stopPropagation();
              setSel({ anchor: { r: 1, c: 1 }, focus: { r: Math.max(used.r2, 1), c: Math.max(used.c2, 1) } });
              grid.current?.focus();
            }} />
            {heads}
            {cells}
            {arrows.length > 0 && (
              <svg className="sht-arrows" style={{ width: HEAD_W + colLeft[nCols + 1], height: HEAD_H + rowY(nRows + 1) }} aria-hidden="true">
                <defs><marker id="sht-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8z" /></marker></defs>
                {arrows}
              </svg>
            )}
            <div className={`sht-sel ${multi ? "multi" : ""}`} style={selBox} />
            {!multi && <div className="sht-active" style={{ ...activeBox, zIndex: 5 }} />}
            {filling && (() => {
              const to = filling.to;
              const box = place(to.r1, to.c1, colLeft[to.c2 + 1] - colLeft[to.c1], rowY(to.r2 + 1) - rowY(to.r1));
              return (
                <>
                  <div className="sht-fill-to" style={{ ...box, zIndex: 6 }} />
                  {filling.tip && <div className="sht-fill-tip" style={{ left: Math.min((box.left as number) + (box.width as number) + 6 / zoom, view.left + view.w - 80 / zoom), top: Math.min((box.top as number) + (box.height as number) + 6 / zoom, view.top + view.h - 30 / zoom), transform: `scale(${1 / zoom})`, transformOrigin: "top left" }}>{filling.tip}</div>}
                </>
              );
            })()}
            {editable && !editing && !filling && (
              <div className="sht-fill-handle" aria-label={t("sheet.fillHandle")} title={t("sheet.fillHandle")} onMouseDown={dragFill}
                style={{ left: (selBox.left as number) + (selBox.width as number) - 4, top: (selBox.top as number) + (selBox.height as number) - 4 }} />
            )}
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
                    advance(e.key === "Enter", e.shiftKey);
                    e.preventDefault();
                  } else if (e.key === "Escape") {
                    setEditing(null);
                    grid.current?.focus();
                  }
                }}
              />
            )}
            {!editing && !filling && selectionFilled && (
              <div className="sht-selection-tools" onMouseDown={(e) => e.stopPropagation()} style={{
                left: Math.max(view.left + HEAD_W, Math.min((selBox.left as number) + (selBox.width as number) + 8 / zoom, view.left + view.w - 96 / zoom)),
                top: Math.max(view.top + HEAD_H, Math.min((selBox.top as number) + (selBox.height as number) + 8 / zoom, view.top + view.h - 40 / zoom)),
                transform: `scale(${1 / zoom})`, transformOrigin: "top left" }}>
                <button onClick={(e) => { e.stopPropagation(); void quoteSelection(); }}><Icon name="chat" />{t("sheet.askAgent")}</button>
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
      <div className="sht-tabs">
        <div className="sht-tablist" role="tablist">
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
        </div>
        {stats && (
          <div className="sht-stats" role="status" aria-label={t("sheet.stats")}>
            {stats.numbers > 0 && !stats.error && <Stat className="avg" label={t("sheet.average")} value={statText(stats.average!, i18n.language)} copy={String(stats.average)} />}
            <Stat label={t("sheet.count")} value={String(stats.count)} copy={String(stats.count)} />
            {stats.numbers > 0 && !stats.error && <Stat label={t("sheet.sum")} value={statText(stats.sum, i18n.language)} copy={String(stats.sum)} />}
          </div>
        )}
        <div className="sht-zoom">
          <button className="tb" aria-label={t("sheet.zoomOut")} onClick={() => setZoomTo(zoom / 1.1)}><Icon name="minus" /></button>
          <button className="sht-zoom-n" title={t("sheet.zoomReset")} onClick={() => setZoomTo(1)}>{Math.round(zoom * 100)}%</button>
          <button className="tb" aria-label={t("sheet.zoomIn")} onClick={() => setZoomTo(zoom * 1.1)}><Icon name="plus" /></button>
        </div>
      </div>
    </div>
  );
}

/** Above this many cells in use the status bar leaves the selection's figures out, as reading them all would lag. */
const STATS_MAX_CELLS = 500_000;

/** A status-bar figure; a click copies its full value, as in Excel. */
function Stat({ label, value, copy, className = "" }: { label: string; value: string; copy: string; className?: string }) {
  const { t } = useTranslation("session");
  const st = useStore();
  return (
    <button className={`sht-stat ${className}`} title={t("sheet.copyStat")} onClick={() => void navigator.clipboard.writeText(copy).then(() => st.show(t("sheet.copied")))}>
      {label}: <b>{value}</b>
    </button>
  );
}

/** A toolbar button with its name beside the icon, as Excel's ribbon has them; a narrow panel keeps the icon. */
function Tool({ icon, label, tip, on, onClick }: { icon: IconName; label: string; tip?: string; on?: boolean; onClick: () => void }) {
  return (
    <button className={`tb sht-btn ${on ? "on" : ""}`} title={tip ?? label} aria-label={label} aria-pressed={on} onClick={onClick}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}
