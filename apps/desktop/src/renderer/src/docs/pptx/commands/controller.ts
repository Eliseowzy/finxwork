// One editor's ribbon state: selection, document reads, host-only state (painter, clipboard,
// panes, multi-select) and command dispatch. React subscribes through `subscribe`/`state`.
import type { ShapeSnapshot } from "@betteroffice/pptx";
import type { PptxAsyncEditorApi, PptxPluginContext, PptxPluginEvent } from "@betteroffice/pptx-react";
import { detectCapabilities, type Capability } from "./capabilities.ts";
import { createEngine, type PlacementSurface } from "./engine.ts";
import { applyFormat, command } from "./registry.ts";
import { OFFICE_THEME, readPackageInfo, type LayoutInfo, type ThemeColors } from "./theme.ts";
import { evaluate, type CommandStatus, type Engine, type Host, type Pane, type RibbonState } from "./types.ts";

type Listener = () => void;

export class RibbonController {
  private listeners = new Set<Listener>();
  private api: PptxAsyncEditorApi | null = null;
  engine: Engine | null = null;
  private context: PptxPluginContext<unknown> | null = null;
  private overlay: HTMLElement | null = null;
  private clip: ShapeSnapshot[] = [];
  private caps: ReadonlySet<Capability> = new Set();
  private layouts: LayoutInfo[] = [];
  private theme: ThemeColors = OFFICE_THEME;
  private reading = 0;
  private pendingPrimary: string | null = null;
  private disposed = false;
  panes: Record<Pane, boolean> = { selection: false, find: false, palette: false };
  error: string | null = null;
  current: RibbonState;
  /** Set by the host: what "Ask finx" (⌘L) opens. */
  onAskFinx: (() => void) | null = null;

  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array, readOnly: boolean) {
    this.bytes = bytes;
    this.current = {
      ready: false, readOnly, version: null, size: null, slides: [], slideIndex: -1, selection: null, selected: [],
      layouts: [], theme: OFFICE_THEME, painter: null, copiedFormat: null, clipboard: 0, alignToPage: false, smartGuides: true,
      caps: this.caps, builtin: () => ({ enabled: false, disabledReason: { code: "editor-unavailable", message: "" } }) as never,
    };
    void readPackageInfo(bytes).then(({ theme, layouts }) => { this.theme = theme; this.layouts = layouts; this.patch({ theme, layouts }); });
  }

  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  state = () => this.current;
  private emit() { this.listeners.forEach((f) => f()); }
  private patch(next: Partial<RibbonState>) { this.current = { ...this.current, ...next }; this.emit(); }

  readonly host: Host = {
    open: (pane) => { this.panes = { ...this.panes, [pane]: true }; this.emit(); },
    toggle: (pane) => { this.panes = { ...this.panes, [pane]: !this.panes[pane] }; this.emit(); },
    setPainter: (painter) => this.patch({ painter }),
    setCopiedFormat: (copiedFormat) => this.patch({ copiedFormat }),
    setClipboard: (shapes) => { this.clip = shapes.map((s) => structuredClone(s)); this.patch({ clipboard: this.clip.length }); },
    clipboard: () => this.clip,
    setSelected: (ids) => this.select(ids),
    setAlignToPage: (alignToPage) => this.patch({ alignToPage }),
    setSmartGuides: (smartGuides) => this.patch({ smartGuides }),
    askFinx: () => this.onAskFinx?.(),
    notify: (message) => { this.error = message; this.emit(); },
  };

  readonly surface: PlacementSurface = {
    context: () => this.context,
    overlayOrigin: () => { const r = this.overlay?.getBoundingClientRect(); return r ? { left: r.left, top: r.top } : null; },
  };

  attach(api: PptxAsyncEditorApi) {
    this.api = api;
    this.engine = createEngine(api, this.host, this.surface);
    const unsubscribe = api.commands.subscribe(() => this.patch({ builtin: ((id, args) => api.commands.getState(id, args)) as RibbonState["builtin"] }));
    void api.handleAsync().then(async (access) => {
      this.caps = detectCapabilities(access);
      const deck = await access.snapshot();
      this.patch({ caps: this.caps, size: { width: deck.widthEmu, height: deck.heightEmu }, ready: true, builtin: ((id, args) => api.commands.getState(id, args)) as RibbonState["builtin"] });
      await this.read();
    });
    return () => { unsubscribe(); if (this.api === api) { this.api = null; this.engine = null; } };
  }

  setOverlay(element: HTMLElement | null) { this.overlay = element; }

  /** Plugin lifecycle: the latest context carries selection, geometry and navigation. */
  pluginContext(context: PptxPluginContext<unknown>) { this.context = context; }
  pluginEvent(context: PptxPluginContext<unknown>, event: PptxPluginEvent) {
    this.context = context;
    if (event.type === "selection-change") this.selectionChanged(event.selection);
    else if (event.type === "document-change" || event.type === "load") void this.read();
    else if (event.type === "mode-change") this.patch({ readOnly: event.readOnly });
    else if (event.type === "layout-change") this.emit();
  }
  get pluginState() { return this.context; }

  private selectionChanged(selection: RibbonState["selection"]) {
    const primary = selection?.target.kind === "shape" || selection?.target.kind === "text" ? selection.target.shapeId : null;
    let selected: readonly string[];
    // The editor re-sends its selection after every edit; a primary still inside the host's
    // multi-selection keeps it, so a second align/distribute still sees every object.
    const sameSlide = selection?.slideId === this.current.selection?.slideId;
    if (primary && (primary === this.pendingPrimary || sameSlide) && this.current.selected.includes(primary)) selected = this.current.selected;
    else if (primary) selected = [primary];
    else selected = this.pendingPrimary === "" ? this.current.selected : [];
    this.pendingPrimary = null;
    const slideChanged = selection?.slideId !== this.current.selection?.slideId;
    const before = this.current;
    this.patch({ selection, selected, slideIndex: selection ? this.current.slides.findIndex((s) => s.id === selection.slideId) : before.slideIndex });
    if (slideChanged) void this.read();
    void this.paint(before);
  }

  /** The format painter applies when the selection lands on a new target. */
  private async paint(before: RibbonState) {
    const s = this.current, painter = s.painter;
    if (!painter || !this.engine || !s.selection) return;
    const target = s.selection.target;
    const sameShape = before.selection?.target.kind !== "slide" && target.kind !== "slide" && (before.selection?.target as { shapeId?: string })?.shapeId === target.shapeId;
    if (target.kind === "slide" || target.kind === "text" && target.anchor === target.focus) return;
    if (target.kind === "shape" && sameShape && before.selection?.target.kind === "shape") return;
    try { await applyFormat(this.engine, s, painter.format); }
    catch (e) { this.host.notify(e instanceof Error ? e.message : String(e)); }
    if (!painter.sticky) this.patch({ painter: null });
  }

  /** Host multi-select: the first id becomes the editor's own selection. */
  select(ids: readonly string[]) {
    const unique = [...new Set(ids)];
    const slideId = this.current.selection?.slideId ?? this.current.slides[this.current.slideIndex]?.id;
    this.patch({ selected: unique });
    if (!slideId || !this.engine) return;
    const primary = unique[0];
    const engineSelected = this.current.selection?.target.kind === "shape" ? this.current.selection.target.shapeId : null;
    if (primary && primary !== engineSelected) { this.pendingPrimary = primary; void this.engine.selectShape(slideId, primary); }
    if (!primary && engineSelected) { this.pendingPrimary = ""; void this.api?.clearSelection(); }
  }

  toggleSelected(id: string) {
    const ids = this.current.selected.includes(id) ? this.current.selected.filter((x) => x !== id) : [...this.current.selected, id];
    this.select(ids);
  }

  async read() {
    const api = this.api;
    if (!api || this.disposed) return;
    const ticket = ++this.reading;
    try {
      const content = await api.readContent();
      if (ticket !== this.reading || !content.ok) return;
      const slideId = this.current.selection?.slideId ?? content.slides[0]?.id;
      const slideIndex = Math.max(0, content.slides.findIndex((s) => s.id === slideId));
      const ids = new Set(content.slides[slideIndex]?.shapes.map((s) => s.id));
      this.patch({ version: content.version, slides: content.slides, slideIndex, selected: this.current.selected.filter((id) => ids.has(id)) });
    } catch { /* the editor was replaced */ }
  }

  status(id: string, args?: unknown): CommandStatus {
    const spec = command(id);
    if (!spec) return { enabled: false, gate: "engine", missing: [] };
    return evaluate(spec, this.current, args);
  }

  async run(id: string, args?: unknown) {
    const spec = command(id);
    if (!spec || !this.engine) return;
    if (!evaluate(spec, this.current, args).enabled) return;
    try {
      this.error = null;
      await spec.run(this.engine, this.current, args);
    } catch (e) {
      this.host.notify(e instanceof Error ? e.message : String(e));
    }
    await this.read();
  }

  dispose() { this.disposed = true; this.listeners.clear(); }
}
