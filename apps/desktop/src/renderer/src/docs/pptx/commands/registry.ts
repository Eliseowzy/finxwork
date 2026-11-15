// Every ribbon / shortcut / palette command. Add a command here, give it a label in
// locales/*/session.json (pptx.ribbon.cmd.<id>), and place it in ribbon/layout.ts.
import type { ParagraphAlignment, PptxEditStep, ShapeSnapshot } from "@nimbleoffice/pptx";
import type { PptxCommandId, PptxZOrderMove } from "@nimbleoffice/pptx-react";
import { align, bounds, changed, distribute, type AlignEdge, type DistributeAxis, type Placed } from "./geometry.ts";
import { quickStyles } from "./quickStyles.ts";
import { SHAPE_LIBRARY } from "./shapes.ts";
import { BASELINE, CLEAR_PATCH, formatSteps, pasteFormatSteps, runStyleAt, shapeStyle, shapeSteps, textPatch, type CopiedFormat } from "./textStyle.ts";
import { currentSlide, effectiveRect, objectKind, selectedShapes, shapeById, textRanges, type CommandSpec, type Engine, type Gate, type RibbonState } from "./types.ts";

type AnySpec = CommandSpec<any>;

// ——— gates ———
const slide = (s: RibbonState): Gate | null => currentSlide(s) ? null : "needs-slide";
const shapes = (s: RibbonState): Gate | null => slide(s) ?? (selectedShapes(s).length ? null : "needs-shape");
const presets = (s: RibbonState): Gate | null => shapes(s) ?? (selectedShapes(s).some((x) => x.kind === "shape") ? null : "needs-preset");
const text = (s: RibbonState): Gate | null => slide(s) ?? (s.selection?.target.kind === "text" || selectedShapes(s).some((x) => x.textStories.length) ? null : "needs-text");
const range = (s: RibbonState): Gate | null => text(s) ?? (textRanges(s).length ? null : "needs-text-range");
const several = (n: number) => (s: RibbonState): Gate | null => shapes(s) ?? (selectedShapes(s).length >= n ? null : n >= 3 ? "needs-three" : "needs-two");

/** A built-in BetterOffice command, gated by its own state. */
function builtin<K extends PptxCommandId>(id: string, command: K, args: (a: any) => any, extra: Partial<AnySpec> = {}): AnySpec {
  return {
    id, needs: ["builtin"],
    check: (s, a) => s.builtin(command, args(a)).enabled ? null : "builtin",
    builtinReason: (s, a) => { const st = s.builtin(command, args(a)); return st.enabled ? undefined : st.disabledReason.message; },
    active: (s, a) => { const st = s.builtin(command, args(a)); return typeof st.active === "boolean" || st.active === "mixed" ? st.active : undefined; },
    run: (engine, _s, a) => engine.builtin(command, args(a)),
    ...extra,
  };
}

/** A command the fork has not shipped yet: always grey, says which interface it waits for. */
function pending(id: string, needs: CommandSpec["needs"], extra: Partial<AnySpec> = {}): AnySpec {
  return { id, needs, run: () => {}, ...extra };
}

async function format(engine: Engine, s: RibbonState, patch: Parameters<typeof formatSteps>[1]) {
  await engine.edit(textRanges(s).flatMap((r) => formatSteps(r, patch)));
}

/** The style a range or shape would hand to the painter / ⌘⇧C. */
export function captureFormat(s: RibbonState): CopiedFormat | null {
  const sel = s.selection;
  if (!sel) return null;
  if (sel.target.kind === "text") {
    const shape = shapeById(s, sel.target.shapeId);
    const story = shape?.textStories.find((x) => x.id === (sel.target as { storyId: string }).storyId);
    const offset = Math.min(sel.target.anchor, sel.target.focus);
    return { text: story ? textPatch(runStyleAt(story, offset)) : null, shape: null };
  }
  const shape = selectedShapes(s)[0];
  if (!shape) return null;
  const story = shape.textStories.find((x) => x.length > 1);
  return { text: story ? textPatch(runStyleAt(story, 0)) : null, shape: shapeStyle(shape) };
}

/** Paint a captured format onto the current selection. */
export async function applyFormat(engine: Engine, s: RibbonState, copied: CopiedFormat) {
  const sel = s.selection;
  const slideId = currentSlide(s)?.id;
  if (!sel || !slideId) return;
  if (sel.target.kind === "text") {
    const shape = shapeById(s, sel.target.shapeId);
    const ranges = textRanges(s);
    if (!shape || !ranges.length) return;
    await engine.edit(ranges.flatMap((r) => pasteFormatSteps(copied, { slideId, shape, range: r })));
    return;
  }
  await engine.edit(selectedShapes(s).flatMap((shape) => pasteFormatSteps(copied, { slideId, shape })));
}

function placed(s: RibbonState): Placed[] {
  return selectedShapes(s).map((shape) => ({ id: shape.id, rect: effectiveRect(shape) }));
}

function rectSteps(s: RibbonState, next: Placed[]): PptxEditStep[] {
  const slideId = currentSlide(s)!.id;
  return changed(placed(s), next).map(({ id, rect }) => ({ op: "setShapeRect" as const, target: { slideId, shapeId: id }, rect }));
}

const page = (s: RibbonState) => ({ x: 0, y: 0, width: s.size?.width ?? 0, height: s.size?.height ?? 0 });

/** One selected object aligns to the page, several to their bounds unless "align to page" is on. */
export function alignSteps(s: RibbonState, edge: AlignEdge): PptxEditStep[] {
  const items = placed(s);
  const reference = s.alignToPage || items.length < 2 ? page(s) : bounds(items.map((i) => i.rect));
  return rectSteps(s, align(items, edge, reference));
}

export function distributeSteps(s: RibbonState, axis: DistributeAxis): PptxEditStep[] {
  const items = placed(s);
  return rectSteps(s, distribute(items, axis, s.alignToPage || items.length < 3 ? page(s) : null));
}

const zOrder = (id: string, value: PptxZOrderMove): AnySpec => ({
  id, needs: ["access.zOrder"], check: shapes,
  run: async (engine, s) => {
    const access = await engine.access();
    const slideId = currentSlide(s)!.id;
    const method = ({ front: "bringShapeToFront", back: "sendShapeToBack", forward: "bringShapeForward", backward: "sendShapeBackward" } as const)[value];
    // Several objects keep their relative order: walk so that no two selected objects swap.
    const order = currentSlide(s)!.shapes.map((x) => x.id);
    const ids = selectedShapes(s).map((x) => x.id).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    if (value === "back" || value === "forward") ids.reverse();
    for (const shapeId of ids) {
      try { await access[method](slideId, shapeId); } catch { /* already at the boundary */ }
    }
  },
});

const alignCmd = (edge: AlignEdge): AnySpec => ({ id: `align.${edge}`, needs: ["edit.rect"], check: shapes, run: (engine, s) => engine.edit(alignSteps(s, edge)) });
const distributeCmd = (axis: DistributeAxis): AnySpec => ({
  id: `distribute.${axis}`, needs: ["edit.rect"],
  check: (s) => shapes(s) ?? (s.alignToPage || selectedShapes(s).length >= 3 ? null : "needs-three"),
  run: (engine, s) => engine.edit(distributeSteps(s, axis)),
});
const paragraphAlign = (id: string, value: ParagraphAlignment) => builtin(id, "alignment", () => ({ value }), { shortcut: ({ l: "Mod+Shift+L", ctr: "Mod+Shift+E", r: "Mod+Shift+R", just: "Mod+Shift+J" } as const)[value] });

const fillSteps = (s: RibbonState, color: string | null) => selectedShapes(s).flatMap((shape) => shapeSteps(currentSlide(s)!.id, shape, { fill: color }));
const strokeSteps = (s: RibbonState, stroke: { color?: string; widthPt?: number } | null) => selectedShapes(s).flatMap((shape) => shapeSteps(currentSlide(s)!.id, shape, { stroke }));

async function copyObjects(engine: Engine, s: RibbonState) {
  engine.host.setClipboard(selectedShapes(s));
}

/** Rebuilds clipboard objects on the current slide, offset like PowerPoint's repeated paste. */
async function pasteObjects(engine: Engine, s: RibbonState, source: readonly ShapeSnapshot[], offset: number) {
  const slideId = currentSlide(s)!.id;
  const created: string[] = [];
  for (const shape of source) {
    const rect = effectiveRect(shape);
    const target = { ...rect, x: rect.x + offset, y: rect.y + offset };
    const kind = shape.textBox || shape.placeholder ? { textBox: true as const } : { geometry: shape.geometry };
    const id = await engine.place(kind, slideId, target);
    if (!id) continue;
    created.push(id);
    const steps: PptxEditStep[] = [{ op: "setShapeRect", target: { slideId, shapeId: id }, rect: target }];
    const style = shapeStyle(shape);
    if (style && !("textBox" in kind)) steps.push(...shapeSteps(slideId, { ...shape, id }, style));
    if (Object.keys(shape.adjustValues ?? {}).length && !("textBox" in kind)) steps.push({ op: "setShapeAdjust", target: { slideId, shapeId: id }, adjustments: shape.adjustValues });
    await engine.edit(steps);
    // Text goes into the new object's story with each run's style. Insertions stay inside one
    // paragraph, so paragraphs join with a space. TODO(engine): `setStoryParagraphs` on the access.
    const access = await engine.access();
    const fresh = (await access.snapshot()).slides.find((x) => x.id === slideId)?.shapes.find((x) => x.id === id);
    const story = fresh?.textStories[0], sourceStory = shape.textStories[0];
    if (story && sourceStory) {
      const runs = sourceStory.paragraphs.flatMap((p, i) => [...(i ? [{ text: " ", style: p.runs[0]?.style ?? null }] : []), ...p.runs]);
      const value = runs.map((r) => r.text).join("");
      if (value) {
        await engine.edit([{ op: "insertText", target: { kind: "range", slideId, shapeId: id, storyId: story.id, start: 0, end: 0 }, at: "start", text: value }]);
        let at = 0;
        const formats: PptxEditStep[] = [];
        for (const run of runs) {
          formats.push(...formatSteps({ slideId, shapeId: id, storyId: story.id, start: at, end: at + run.text.length }, textPatch(run.style)));
          at += run.text.length;
        }
        if (formats.length) await engine.edit(formats);
      }
    }
  }
  if (created.length) engine.host.setSelected(created);
}

const EMU_OFFSET = 228600; // 0.25 in, PowerPoint's paste/duplicate offset

const placeable = (shape: ShapeSnapshot) => shape.kind === "shape" && (shape.textBox || !!shape.placeholder || SHAPE_LIBRARY.some((e) => e.geometry === shape.geometry && e.placeable));

export const COMMANDS: readonly AnySpec[] = [
  // ——— History, view ———
  builtin("undo", "undo", () => null, { shortcut: "Mod+Z" }),
  builtin("redo", "redo", () => null, { shortcut: "Mod+Shift+Z" }),
  builtin("zoom", "zoom", (a: { scale: number | "fit" }) => a, { mutates: false }),
  builtin("slideshow", "slideshow", () => null, { mutates: false, shortcut: "F5" }),
  builtin("proposals", "proposalsPanel", () => null, { mutates: false }),
  { id: "smartGuides", mutates: false, active: (s) => s.smartGuides, run: (e, s) => e.host.setSmartGuides(!s.smartGuides) },
  pending("gridlines", ["access.setSlideSize"], { mutates: false }), // TODO(engine/host): grid needs a snap target in the drag path

  // ——— Clipboard ———
  { id: "cut", needs: ["access.removeShape"], check: (s) => shapes(s) ?? (selectedShapes(s).every(placeable) ? null : "needs-preset"), shortcut: "Mod+X",
    run: async (e, s) => { await copyObjects(e, s); const a = await e.access(); for (const x of selectedShapes(s)) await a.removeShape(currentSlide(s)!.id, x.id); e.host.setSelected([]); } },
  { id: "copy", mutates: false, check: shapes, shortcut: "Mod+C", run: copyObjects },
  { id: "paste", check: (s) => slide(s) ?? (s.clipboard ? null : "needs-clipboard"), shortcut: "Mod+V",
    run: (e, s) => pasteObjects(e, s, e.host.clipboard(), e.host.clipboard().some((x) => currentSlide(s)?.shapes.some((y) => y.id === x.id)) ? EMU_OFFSET : 0) },
  { id: "duplicate", check: (s) => shapes(s) ?? (selectedShapes(s).every(placeable) ? null : "needs-preset"), shortcut: "Mod+D",
    run: (e, s) => pasteObjects(e, s, selectedShapes(s), EMU_OFFSET) },
  { id: "formatPainter", check: (s) => slide(s) ?? (captureFormat(s) ? null : "needs-format"), active: (s) => !!s.painter,
    run: (e, s, a?: { sticky?: boolean }) => {
      if (s.painter && !a?.sticky) return e.host.setPainter(null);
      const format = captureFormat(s);
      if (format) e.host.setPainter({ format, sticky: !!a?.sticky });
    } },
  { id: "copyFormat", mutates: false, check: (s) => slide(s) ?? (captureFormat(s) ? null : "needs-format"), shortcut: "Mod+Shift+C",
    run: (e, s) => { const f = captureFormat(s); if (f) e.host.setCopiedFormat(f); } },
  { id: "pasteFormat", needs: ["edit.format", "edit.fill"], check: (s) => !s.copiedFormat ? "needs-format" : s.selection?.target.kind === "text" ? (textRanges(s).length ? null : "needs-text-range") : shapes(s), shortcut: "Mod+Shift+V",
    run: (e, s) => s.copiedFormat ? applyFormat(e, s, s.copiedFormat) : undefined },
  pending("pasteSpecial", ["access.pasteShapes"]),

  // ——— Slides ———
  { id: "newSlide", needs: ["builtin"], shortcut: "Mod+M", check: (s, a?: { layoutPartPath?: string | null }) => {
      if (!a?.layoutPartPath) return s.builtin("insertSlide").enabled ? null : "builtin";
      return s.builtin("insertSlide", { layoutPartPath: a.layoutPartPath }).enabled || s.caps.has("access.layouts") ? null : "needs-layout";
    },
    run: (e, _s, a?: { layoutPartPath?: string | null }) => e.builtin("insertSlide", a?.layoutPartPath ? { layoutPartPath: a.layoutPartPath } : {}) },
  { id: "duplicateSlide", needs: ["access.duplicateSlide"], check: slide,
    run: async (e, s) => { const a = await e.access() as unknown as { duplicateSlide(id: string, to: number): Promise<unknown> }; await a.duplicateSlide(currentSlide(s)!.id, s.slideIndex + 1); } },
  { id: "deleteSlide", needs: ["access.deleteSlide"], check: (s) => slide(s) ?? (s.slides.length > 1 ? null : "last-slide"),
    run: async (e, s) => { const a = await e.access(); await a.deleteSlide(currentSlide(s)!.id); } },
  { id: "slideLayout", needs: ["access.setSlideLayout"], check: (s, a?: { layoutPartPath: string }) => slide(s) ?? (a && currentSlide(s)?.layoutPartPath === a.layoutPartPath ? "needs-layout" : null),
    active: (s, a?: { layoutPartPath: string }) => !!a && currentSlide(s)?.layoutPartPath === a.layoutPartPath,
    run: async (e, s, a: { layoutPartPath: string }) => {
      // TODO(engine): 0.5.1's handle takes a layout id; map the part path once `layouts()` is on the access.
      const access = await e.access() as unknown as { setSlideLayout(slideId: string, layout: string): Promise<unknown> };
      await access.setSlideLayout(currentSlide(s)!.id, a.layoutPartPath);
    } },
  pending("resetSlide", ["access.resetSlide"]),
  pending("section", ["access.sections"]),

  // ——— Font ———
  builtin("fontFamily", "fontFamily", (a: { family: string }) => a),
  builtin("fontSize", "fontSize", (a: { points: number }) => a),
  builtin("growFont", "fontSizeStep", () => ({ direction: "increase" }), { shortcut: "Mod+Shift+." }),
  builtin("shrinkFont", "fontSizeStep", () => ({ direction: "decrease" }), { shortcut: "Mod+Shift+," }),
  builtin("bold", "bold", () => null, { shortcut: "Mod+B" }),
  builtin("italic", "italic", () => null, { shortcut: "Mod+I" }),
  builtin("underline", "underline", () => null, { shortcut: "Mod+U" }),
  pending("strike", ["text.strike"]),
  { id: "superscript", needs: ["edit.format"], check: range, shortcut: "Mod+Shift+=",
    active: (s) => superActive(s, BASELINE.superscript), run: (e, s) => format(e, s, { baselinePct: superActive(s, BASELINE.superscript) ? 0 : BASELINE.superscript }) },
  { id: "subscript", needs: ["edit.format"], check: range, shortcut: "Mod+=",
    active: (s) => superActive(s, BASELINE.subscript), run: (e, s) => format(e, s, { baselinePct: superActive(s, BASELINE.subscript) ? 0 : BASELINE.subscript }) },
  { id: "charSpacing", needs: ["edit.format"], check: range, run: (e, s, a: { points: number }) => format(e, s, { spacingPt: a.points }) },
  builtin("textColor", "textColor", (a: { color: string }) => a),
  pending("highlight", ["text.highlight"]),
  pending("changeCase", ["text.caps"]),
  { id: "clearFormat", needs: ["edit.format"], check: range, shortcut: "Mod+Space", run: (e, s) => format(e, s, CLEAR_PATCH) },

  // ——— Paragraph ———
  pending("bullets", ["access.setParagraphProperties"]),
  pending("numbering", ["access.setParagraphProperties"]),
  pending("indentLess", ["access.setParagraphProperties"]),
  pending("indentMore", ["access.setParagraphProperties"]),
  pending("lineSpacing", ["access.setParagraphProperties"]),
  pending("paragraphSpacing", ["access.setParagraphProperties"]),
  paragraphAlign("alignLeft", "l"), paragraphAlign("alignCenter", "ctr"), paragraphAlign("alignRight", "r"), paragraphAlign("justify", "just"),
  pending("distributed", ["access.setParagraphProperties"]),
  pending("textDirection", ["access.setTextBodyProperties"]),
  pending("verticalAlign", ["access.setTextBodyProperties"]),
  pending("columns", ["access.setTextBodyProperties"]),

  // ——— Drawing / arrange ———
  builtin("textBox", "tool", () => ({ value: "textBox" })),
  { id: "insertShape", needs: ["builtin"], check: (s, a?: { geometry: string }) => {
      const entry = SHAPE_LIBRARY.find((x) => x.geometry === a?.geometry);
      if (entry && !entry.placeable && !s.caps.has("access.addShape")) return "engine";
      return s.builtin("tool", { value: "shape:rect" }).enabled ? null : "builtin";
    },
    active: (s, a?: { geometry: string }) => !!a && s.builtin("tool").value === `shape:${a.geometry}`,
    run: (e, _s, a: { geometry: string }) => e.builtin("tool", { value: `shape:${a.geometry}` as `shape:rect` }) },
  builtin("insertPicture", "insertImage", () => null),
  zOrder("bringToFront", "front"), zOrder("bringForward", "forward"), zOrder("sendBackward", "backward"), zOrder("sendToBack", "back"),
  alignCmd("left"), alignCmd("center"), alignCmd("right"), alignCmd("top"), alignCmd("middle"), alignCmd("bottom"),
  distributeCmd("horizontal"), distributeCmd("vertical"),
  { id: "alignToPage", mutates: false, active: (s) => s.alignToPage, run: (e, s) => e.host.setAlignToPage(!s.alignToPage) },
  pending("group", ["access.groupShapes"], { shortcut: "Mod+G" }),
  pending("ungroup", ["access.ungroupShapes"], { shortcut: "Mod+Shift+G" }),
  pending("rotateRight", ["access.setShapeTransform"]),
  pending("rotateLeft", ["access.setShapeTransform"]),
  pending("flipHorizontal", ["access.setShapeTransform"]),
  pending("flipVertical", ["access.setShapeTransform"]),
  { id: "quickStyle", needs: ["edit.fill", "edit.stroke", "edit.format"], check: presets,
    run: (e, s, a: { id: string }) => {
      const style = quickStyles(s.theme).find((x) => x.id === a.id);
      if (!style) return;
      const slideId = currentSlide(s)!.id;
      return e.edit(selectedShapes(s).filter((x) => x.kind === "shape").flatMap((shape) => pasteFormatSteps(
        { shape: { fill: style.fill, stroke: style.stroke ? { color: style.stroke, widthPt: style.strokeWidthPt ?? 1 } : null }, text: { color: style.text } },
        { slideId, shape })));
    } },
  { id: "shapeFill", needs: ["edit.fill"], check: presets, run: (e, s, a: { color: string | null }) => e.edit(fillSteps(s, a.color)) },
  { id: "shapeOutline", needs: ["edit.stroke"], check: presets, run: (e, s, a: { color: string | null }) => e.edit(strokeSteps(s, a.color ? { color: a.color } : null)) },
  { id: "outlineWidth", needs: ["edit.stroke"], check: presets, run: (e, s, a: { points: number | null }) => e.edit(strokeSteps(s, a.points ? { widthPt: a.points } : null)) },
  pending("outlineDash", ["access.setShapeTransform"]),
  pending("shapeEffects", ["access.setShapeTransform"]),
  pending("gradientFill", ["access.setShapeTransform"]),

  // ——— Editing ———
  { id: "find", mutates: false, check: slide, shortcut: "Mod+F", run: (e) => e.host.open("find") },
  { id: "replace", check: slide, shortcut: "Mod+Alt+F", run: (e) => e.host.open("find") },
  { id: "selectionPane", mutates: false, check: slide, active: () => undefined, run: (e) => e.host.toggle("selection") },
  { id: "selectAll", mutates: false, check: slide, shortcut: "Mod+A", run: (e, s) => e.host.setSelected(currentSlide(s)!.shapes.filter((x) => !x.hidden).map((x) => x.id)) },

  // ——— Insert ———
  pending("table", ["access.insertTable"]),
  pending("chart", ["access.insertChart"]),
  pending("icons", ["access.addShape"]),
  pending("link", ["access.setHyperlink"], { shortcut: "Mod+K" }),
  pending("headerFooter", ["access.setHeaderFooter"]),
  pending("slideNumber", ["access.setHeaderFooter"]),
  pending("dateTime", ["access.setHeaderFooter"]),

  // ——— Design ———
  { id: "background", needs: ["edit.background"], check: slide,
    run: (e, s, a: { color: string | null; all?: boolean }) => e.edit((a.all ? s.slides : [currentSlide(s)!]).map((x) => ({
      op: "setSlideBackground" as const, target: { slideId: x.id }, background: a.color ? { type: "solid", color: { rgb: a.color.replace("#", "").toUpperCase() } } : null,
    }))) },
  pending("slideSize", ["access.setSlideSize"]),
  pending("themes", ["access.applyTheme"]),

  // ——— Animations, slide show ———
  pending("transitions", ["access.setSlideTransition"]),
  pending("animations", ["access.setAnimations"]),
  pending("presenterView", ["access.setSlideTransition"]), // TODO(host): presenter window; not an engine gap

  // ——— Table (contextual) ———
  ...(["insertRowAbove", "insertRowBelow", "insertColumnLeft", "insertColumnRight", "deleteRow", "deleteColumn"] as const).map((id): AnySpec => ({
    id, needs: ["access.table"], check: (s) => tableCell(s) ? null : "needs-table",
    run: async (e, s) => {
      const cell = tableCell(s)!;
      const a = await e.access();
      const slideId = currentSlide(s)!.id;
      if (id === "insertRowAbove" || id === "insertRowBelow") await a.insertTableRow(slideId, cell.shapeId, cell.row, id === "insertRowAbove" ? "before" : "after");
      else if (id === "insertColumnLeft" || id === "insertColumnRight") await a.insertTableColumn(slideId, cell.shapeId, cell.column, id === "insertColumnLeft" ? "before" : "after");
      else if (id === "deleteRow") await a.deleteTableRow(slideId, cell.shapeId, cell.row);
      else await a.deleteTableColumn(slideId, cell.shapeId, cell.column);
    },
  })),
  pending("mergeCells", ["access.mergeTableCells"]),
  pending("cellShading", ["access.setTableCellStyle"]),
  pending("cellBorders", ["access.setTableCellStyle"]),
  pending("tableStyles", ["access.setTableCellStyle"]),
  // ——— Picture / chart (contextual) ———
  pending("crop", ["access.setPictureCrop"]),
  pending("replacePicture", ["access.addPicture"]),
  pending("editChartData", ["access.insertChart"]),
  pending("chartType", ["access.insertChart"]),

  // ——— AI and the palette ———
  { id: "palette", mutates: false, shortcut: "Mod+K", run: (e) => e.host.toggle("palette") },
  { id: "askFinx", mutates: false, shortcut: "Mod+L", run: (e) => e.host.askFinx() },
];

function superActive(s: RibbonState, value: number): boolean {
  const ranges = textRanges(s);
  if (!ranges.length) return false;
  const shape = shapeById(s, ranges[0].shapeId);
  const story = shape?.textStories.find((x) => x.id === ranges[0].storyId);
  return !!story && runStyleAt(story, ranges[0].start)?.baselinePct === value;
}

/**
 * The table cell holding the caret. Cell stories are addressed `story:<shape>:<row>:<column>`
 * in 0.5.1. TODO(engine): expose the cell on the selection instead of parsing ids.
 */
export function tableCell(s: RibbonState): { shapeId: string; row: number; column: number } | null {
  const sel = s.selection;
  if (sel?.target.kind !== "text" || objectKind(s) !== "table") return null;
  const match = /:(\d+):(\d+)$/.exec(sel.target.storyId.slice(sel.target.shapeId.length + "story:".length));
  return match ? { shapeId: sel.target.shapeId, row: Number(match[1]), column: Number(match[2]) } : null;
}

const byId = new Map(COMMANDS.map((c) => [c.id, c]));
export const command = (id: string): AnySpec | undefined => byId.get(id);
export const commandIds = () => [...byId.keys()];
