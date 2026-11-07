// The command layer's contract. Ribbon buttons, shortcuts, the ⌘K palette and (later) AI actions
// all go through `CommandSpec.run(engine, state, args)`; only `Engine` talks to BetterOffice.
import type { PptxEditStep, PptxFindMatch, ShapeSnapshot, SlideSnapshot } from "@betteroffice/pptx";
import type { PptxAsyncEditorAccess, PptxCommandArgs, PptxCommandId, PptxCommandState, PptxPluginSelection } from "@betteroffice/pptx-react";
import type { Capability } from "./capabilities.ts";
import type { Rect } from "./geometry.ts";
import type { LayoutInfo, ThemeColors } from "./theme.ts";
import type { CopiedFormat } from "./textStyle.ts";

export type Pane = "selection" | "find" | "palette";

/** A snapshot of everything a command decides on. Rebuilt on every selection or document change. */
export interface RibbonState {
  ready: boolean;
  readOnly: boolean;
  version: string | null;
  /** Slide size in EMU. */
  size: { width: number; height: number } | null;
  slides: readonly SlideSnapshot[];
  slideIndex: number;
  selection: PptxPluginSelection;
  /** Selected top-level shapes: the editor's own selection first, then shift/⌘-clicked extras. */
  selected: readonly string[];
  layouts: readonly LayoutInfo[];
  theme: ThemeColors;
  /** Armed format painter; `sticky` after a double click, until Esc. */
  painter: { format: CopiedFormat; sticky: boolean } | null;
  /** ⌘⇧C copied format. */
  copiedFormat: CopiedFormat | null;
  /** Objects on the in-app clipboard. */
  clipboard: number;
  /** Align/distribute against the page instead of the selection. */
  alignToPage: boolean;
  smartGuides: boolean;
  caps: ReadonlySet<Capability>;
  builtin: <K extends PptxCommandId>(id: K, args?: PptxCommandArgs[K]) => PptxCommandState<K>;
}

export type TextRange = { slideId: string; shapeId: string; storyId: string; start: number; end: number };

/** Host-side effects of commands: panes, the painter, the clipboard. */
export interface Host {
  open(pane: Pane): void;
  toggle(pane: Pane): void;
  setPainter(painter: RibbonState["painter"]): void;
  setCopiedFormat(format: CopiedFormat | null): void;
  setClipboard(shapes: readonly ShapeSnapshot[]): void;
  clipboard(): readonly ShapeSnapshot[];
  setSelected(ids: readonly string[]): void;
  setAlignToPage(value: boolean): void;
  setSmartGuides(value: boolean): void;
  askFinx(): void;
  notify(message: string): void;
}

/** The only door to BetterOffice. The real one wraps `PptxAsyncEditorApi`; tests use a fake. */
export interface Engine {
  builtin<K extends PptxCommandId>(id: K, args: PptxCommandArgs[K]): Promise<void>;
  access(): Promise<PptxAsyncEditorAccess>;
  /** One `applyEdits` batch at the latest version: one undo step. Throws on refusal. */
  edit(steps: readonly PptxEditStep[]): Promise<void>;
  selectShape(slideId: string, shapeId: string): Promise<void>;
  selectText(range: TextRange): Promise<void>;
  goToSlide(index: number): Promise<void>;
  findText(text: string): Promise<PptxFindMatch[]>;
  /** Creates a preset shape or text box at `rect` (EMU) and returns its id, or null when it cannot. */
  place(kind: { geometry: string } | { textBox: true }, slideId: string, rect: Rect): Promise<string | null>;
  host: Host;
}

export type Gate =
  | "read-only" | "not-ready" | "engine" | "builtin"
  | "needs-slide" | "needs-text" | "needs-text-range" | "needs-shape" | "needs-preset" | "needs-two" | "needs-three"
  | "needs-table" | "needs-format" | "needs-clipboard" | "needs-layout" | "last-slide";

export interface CommandSpec<A = undefined> {
  id: string;
  /** Interfaces the command calls; any missing one greys it as waiting for the engine. */
  needs?: readonly Capability[];
  /** Display chord, `Mod` = ⌘ on macOS. */
  shortcut?: string;
  /** Whether it changes the document; such commands are off while read-only. */
  mutates?: boolean;
  check?(state: RibbonState, args: A): Gate | null;
  active?(state: RibbonState, args: A): boolean | "mixed" | undefined;
  /** A built-in's own disabled reason, shown when `check` returns "builtin". */
  builtinReason?(state: RibbonState, args: A): string | undefined;
  run(engine: Engine, state: RibbonState, args: A): Promise<void> | void;
}

export interface CommandStatus {
  enabled: boolean;
  gate: Gate | null;
  /** Missing capabilities when `gate === "engine"`. */
  missing: Capability[];
  message?: string;
  active?: boolean | "mixed";
}

export function evaluate<A>(spec: CommandSpec<A>, state: RibbonState, args: A): CommandStatus {
  const missing = (spec.needs ?? []).filter((cap) => !state.caps.has(cap));
  if (missing.length) return { enabled: false, gate: "engine", missing };
  if (!state.ready) return { enabled: false, gate: "not-ready", missing };
  if (spec.mutates !== false && state.readOnly) return { enabled: false, gate: "read-only", missing };
  const gate = spec.check?.(state, args) ?? null;
  const active = spec.active?.(state, args);
  if (gate) return { enabled: false, gate, missing, active, message: gate === "builtin" ? spec.builtinReason?.(state, args) : undefined };
  return { enabled: true, gate: null, missing, active };
}

// ——— State helpers shared by commands and the ribbon ———

export const currentSlide = (state: RibbonState): SlideSnapshot | null => state.slides[state.slideIndex] ?? null;

export function shapeById(state: RibbonState, id: string): ShapeSnapshot | null {
  return currentSlide(state)?.shapes.find((shape) => shape.id === id) ?? null;
}

export const selectedShapes = (state: RibbonState): ShapeSnapshot[] =>
  state.selected.map((id) => shapeById(state, id)).filter((shape): shape is ShapeSnapshot => !!shape);

/** The rect the shape draws at: a placeholder without its own transform uses its layout's. */
export function effectiveRect(shape: ShapeSnapshot): Rect {
  const own = shape.width > 0 || shape.height > 0 || shape.x !== 0 || shape.y !== 0;
  const source = !own && shape.inherited ? shape.inherited : shape;
  return { x: source.x, y: source.y, width: source.width, height: source.height };
}

/** The selected text range, or every story of the selected shapes when objects are selected. */
export function textRanges(state: RibbonState): TextRange[] {
  const selection = state.selection;
  if (!selection) return [];
  if (selection.target.kind === "text") {
    const { shapeId, storyId, anchor, focus } = selection.target;
    if (anchor !== focus) return [{ slideId: selection.slideId, shapeId, storyId, start: Math.min(anchor, focus), end: Math.max(anchor, focus) }];
    return [];
  }
  return selectedShapes(state).flatMap((shape) => shape.textStories
    .filter((story) => story.length > 1)
    .map((story) => ({ slideId: selection.slideId, shapeId: shape.id, storyId: story.id, start: 0, end: story.length - 1 })));
}

export type ObjectKind = "shape" | "picture" | "table" | "chart" | "group" | null;

export function graphicKind(shape: ShapeSnapshot): "table" | "chart" | null {
  const graphic = shape.graphic as { kind?: string; type?: string; uri?: string; table?: unknown; chart?: unknown } | null;
  if (!graphic) return null;
  const text = JSON.stringify(Object.keys(graphic)) + (graphic.kind ?? "") + (graphic.type ?? "") + (graphic.uri ?? "");
  if (/table/i.test(text)) return "table";
  if (/chart/i.test(text)) return "chart";
  return null;
}

/** The selection's object kind, for contextual tabs. */
export function objectKind(state: RibbonState): ObjectKind {
  const primary = state.selection?.target.kind === "text" ? shapeById(state, state.selection.target.shapeId) : selectedShapes(state)[0];
  if (!primary) return null;
  if (primary.kind === "picture") return "picture";
  if (primary.kind === "group") return "group";
  if (primary.kind === "graphicFrame") return graphicKind(primary) ?? "chart";
  return "shape";
}
