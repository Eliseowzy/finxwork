// Where commands sit: tabs → groups → items. The command layer decides what an item does and
// whether it is available; this file only arranges. Compact mode keeps the order and moves what
// does not fit into "More".
import type { ObjectKind } from "../commands/types.ts";

export type TabId = "home" | "insert" | "design" | "animations" | "slideshow" | "view" | "shapeFormat" | "table" | "chart" | "pictureFormat";

export type Item =
  | { kind: "button"; cmd: string; icon: string; args?: unknown; big?: boolean; label?: boolean }
  | { kind: "menu"; id: string; icon: string; items: readonly { cmd: string; icon: string; args?: unknown; sep?: boolean }[] }
  | { kind: "control"; control: Control; cmd?: string };

export type Control = "fontFamily" | "fontSize" | "textColor" | "charSpacing" | "newSlide" | "layouts" | "shapes" | "quickStyles"
  | "shapeFill" | "shapeOutline" | "background" | "zoom" | "painter";

export type Group = { id: string; items: readonly Item[] };
export type Tab = { id: TabId; groups: readonly Group[]; context?: ObjectKind };

const b = (cmd: string, icon: string, extra: Partial<Extract<Item, { kind: "button" }>> = {}): Item => ({ kind: "button", cmd, icon, ...extra });
const c = (control: Control, cmd?: string): Item => ({ kind: "control", control, cmd });

const ARRANGE: Item = { kind: "menu", id: "arrange", icon: "BringToFront", items: [
  { cmd: "bringToFront", icon: "BringToFront" }, { cmd: "bringForward", icon: "ArrowUp" }, { cmd: "sendBackward", icon: "ArrowDown" }, { cmd: "sendToBack", icon: "SendToBack" },
  { cmd: "group", icon: "Group", sep: true }, { cmd: "ungroup", icon: "Ungroup" },
  { cmd: "rotateRight", icon: "RotateCw", sep: true }, { cmd: "rotateLeft", icon: "RotateCcw" }, { cmd: "flipHorizontal", icon: "FlipHorizontal2" }, { cmd: "flipVertical", icon: "FlipVertical2" },
] };
const ALIGN: Item = { kind: "menu", id: "alignObjects", icon: "AlignStartVertical", items: [
  { cmd: "align.left", icon: "AlignStartVertical" }, { cmd: "align.center", icon: "AlignCenterVertical" }, { cmd: "align.right", icon: "AlignEndVertical" },
  { cmd: "align.top", icon: "AlignStartHorizontal", sep: true }, { cmd: "align.middle", icon: "AlignCenterHorizontal" }, { cmd: "align.bottom", icon: "AlignEndHorizontal" },
  { cmd: "distribute.horizontal", icon: "AlignHorizontalDistributeCenter", sep: true }, { cmd: "distribute.vertical", icon: "AlignVerticalDistributeCenter" },
  { cmd: "alignToPage", icon: "Frame", sep: true },
] };
const PARAGRAPH_MORE: Item = { kind: "menu", id: "paragraphMore", icon: "WrapText", items: [
  { cmd: "lineSpacing", icon: "ArrowDownUp" }, { cmd: "paragraphSpacing", icon: "BetweenHorizontalStart" },
  { cmd: "distributed", icon: "MoveHorizontal", sep: true }, { cmd: "textDirection", icon: "LetterText" }, { cmd: "verticalAlign", icon: "AlignCenterHorizontal" }, { cmd: "columns", icon: "Columns2" },
] };

export const TABS: readonly Tab[] = [
  { id: "home", groups: [
    { id: "clipboard", items: [b("paste", "ClipboardPaste", { big: true }), b("cut", "Scissors"), b("copy", "Copy"), c("painter")] },
    { id: "slides", items: [c("newSlide"), c("layouts"), b("duplicateSlide", "CopyPlus"), b("deleteSlide", "Trash2"), b("resetSlide", "RotateCcw"), b("section", "Rows3")] },
    { id: "font", items: [c("fontFamily"), c("fontSize"), b("growFont", "AArrowUp"), b("shrinkFont", "AArrowDown"), b("clearFormat", "RemoveFormatting"),
      b("bold", "Bold"), b("italic", "Italic"), b("underline", "Underline"), b("strike", "Strikethrough"), b("superscript", "Superscript"), b("subscript", "Subscript"),
      c("charSpacing"), b("changeCase", "CaseSensitive"), b("highlight", "Highlighter"), c("textColor")] },
    { id: "paragraph", items: [b("bullets", "List"), b("numbering", "ListOrdered"), b("indentLess", "IndentDecrease"), b("indentMore", "IndentIncrease"),
      b("alignLeft", "AlignLeft"), b("alignCenter", "AlignCenter"), b("alignRight", "AlignRight"), b("justify", "AlignJustify"), PARAGRAPH_MORE] },
    { id: "drawing", items: [c("shapes"), b("textBox", "Type"), ARRANGE, ALIGN, c("quickStyles"), c("shapeFill"), c("shapeOutline")] },
    { id: "editing", items: [b("find", "Search"), b("replace", "Replace"), b("selectAll", "SquareMousePointer"), b("selectionPane", "Layers")] },
  ] },
  { id: "insert", groups: [
    { id: "slides", items: [c("newSlide"), b("duplicateSlide", "CopyPlus")] },
    { id: "tables", items: [b("table", "Table", { big: true })] },
    { id: "images", items: [b("insertPicture", "Image", { big: true })] },
    { id: "illustrations", items: [c("shapes"), b("icons", "Smile"), b("chart", "ChartColumn")] },
    { id: "text", items: [b("textBox", "Type"), b("headerFooter", "PanelBottom"), b("slideNumber", "Hash"), b("dateTime", "CalendarDays")] },
    { id: "links", items: [b("link", "Link")] },
  ] },
  { id: "design", groups: [
    { id: "themes", items: [b("themes", "Palette", { big: true })] },
    { id: "customize", items: [b("slideSize", "Scan"), c("background")] },
  ] },
  { id: "animations", groups: [
    { id: "transitions", items: [b("transitions", "Film", { big: true })] },
    { id: "animation", items: [b("animations", "WandSparkles", { big: true })] },
  ] },
  { id: "slideshow", groups: [
    { id: "start", items: [b("slideshow", "Play", { big: true, label: true }), b("presenterView", "MonitorPlay")] },
  ] },
  { id: "view", groups: [
    { id: "zoom", items: [c("zoom")] },
    { id: "show", items: [b("smartGuides", "Magnet"), b("gridlines", "Grid3x3")] },
    { id: "panes", items: [b("selectionPane", "Layers"), b("proposals", "Sparkles")] },
  ] },
  { id: "shapeFormat", context: "shape", groups: [
    { id: "insertShapes", items: [c("shapes"), b("textBox", "Type")] },
    { id: "shapeStyles", items: [c("quickStyles"), c("shapeFill"), c("shapeOutline"), b("shapeEffects", "Sparkles"), b("gradientFill", "Brush")] },
    { id: "arrange", items: [ARRANGE, ALIGN, b("selectionPane", "Layers")] },
  ] },
  { id: "pictureFormat", context: "picture", groups: [
    { id: "adjust", items: [b("replacePicture", "ImageUp"), b("crop", "Crop")] },
    { id: "arrange", items: [ARRANGE, ALIGN, b("selectionPane", "Layers")] },
  ] },
  { id: "table", context: "table", groups: [
    { id: "rowsColumns", items: [b("insertRowAbove", "BetweenHorizontalStart"), b("insertRowBelow", "BetweenHorizontalStart"), b("insertColumnLeft", "BetweenVerticalStart"), b("insertColumnRight", "BetweenVerticalStart"), b("deleteRow", "Trash2"), b("deleteColumn", "Trash2")] },
    { id: "merge", items: [b("mergeCells", "TableCellsMerge")] },
    { id: "tableStyles", items: [b("tableStyles", "Grid2x2"), b("cellShading", "PaintBucket"), b("cellBorders", "Square")] },
    { id: "arrange", items: [ARRANGE, ALIGN] },
  ] },
  { id: "chart", context: "chart", groups: [
    { id: "chartData", items: [b("editChartData", "Sheet"), b("chartType", "ChartColumn")] },
    { id: "arrange", items: [ARRANGE, ALIGN] },
  ] },
];

/** Static width estimates (px) for the compact row: no measuring pass, so no flicker. */
export function itemWidth(item: Item): number {
  if (item.kind !== "control") return item.kind === "menu" ? 40 : item.big || item.label ? 30 : 30;
  return ({ fontFamily: 132, fontSize: 64, textColor: 40, charSpacing: 40, newSlide: 46, layouts: 40, shapes: 40, quickStyles: 40, shapeFill: 40, shapeOutline: 40, background: 40, zoom: 150, painter: 30 } as const)[item.control];
}
