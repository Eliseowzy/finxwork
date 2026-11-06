// Text and shape style reading for the format painter, ⌘⇧C/⌘⇧V and clear formatting.
// Pure: input is engine snapshots, output is `PptxEditStep`s for one `applyEdits` batch.
import type { PptxEditStep, ShapeSnapshot, StorySnapshot, TextStyle, TextStyleSnapshot } from "@betteroffice/pptx";

export type ShapeStyle = { fill?: string | null; stroke?: { color?: string; widthPt?: number } | null };
/** What a painter or ⌘⇧C carries: run formatting, shape formatting, or both (a shape with text). */
export type CopiedFormat = { text: TextStyle | null; shape: ShapeStyle | null };

/** `formatText` patch keys the 0.5.1 engine accepts. Strikethrough, highlight and caps are not among them. */
const TEXT_KEYS = ["bold", "italic", "fontSizePt", "color", "fontFamily", "underline", "spacingPt", "baselinePct"] as const;

export function textPatch(style: TextStyleSnapshot | TextStyle | null | undefined): TextStyle {
  const patch: Record<string, unknown> = {};
  if (!style) return patch;
  for (const key of TEXT_KEYS) {
    const value = (style as Record<string, unknown>)[key];
    if (value !== null && value !== undefined) patch[key] = value;
  }
  // Snapshots carry #RRGGBB or RRGGBB; formatText takes #RRGGBB.
  if (typeof patch.color === "string" && !String(patch.color).startsWith("#")) patch.color = `#${patch.color}`;
  return patch as TextStyle;
}

/** The style of the run that holds `offset` (paragraph marks count one UTF-16 unit, as the engine counts). */
export function runStyleAt(story: StorySnapshot, offset: number): TextStyleSnapshot | null {
  let at = 0, last: TextStyleSnapshot | null = null;
  for (const paragraph of story.paragraphs) {
    for (const run of paragraph.runs) {
      if (offset >= at && offset < at + run.text.length) return run.style;
      at += run.text.length;
      last = run.style;
    }
    at += 1;
    if (offset < at && last) return last;
  }
  return last;
}

/** Text length of a story without its final paragraph mark: the range a whole-story format covers. */
export const storyTextEnd = (story: StorySnapshot) => Math.max(0, story.length - 1);

const emuToPt = (emu: number) => Math.round(emu / 12700 * 100) / 100;

export function shapeStyle(shape: ShapeSnapshot): ShapeStyle | null {
  if (shape.kind !== "shape") return null;
  const fill = shape.fill ? shape.resolvedFillColor ?? undefined : null;
  const outline = shape.outline;
  const stroke = outline && outline.width !== 0 && shape.resolvedOutlineColor
    ? { color: shape.resolvedOutlineColor, ...(outline.width ? { widthPt: emuToPt(outline.width) } : {}) }
    : outline ? null : undefined;
  return { ...(fill !== undefined ? { fill } : {}), ...(stroke !== undefined ? { stroke } : {}) };
}

export type TextTarget = { slideId: string; shapeId: string; storyId: string; start: number; end: number };

export function formatSteps(target: TextTarget, patch: TextStyle): PptxEditStep[] {
  if (!Object.keys(patch).length || target.end <= target.start) return [];
  return [{ op: "formatText", target: { kind: "range", ...target }, patch }];
}

/** Every story of a shape, whole. */
export function shapeStoryTargets(slideId: string, shape: ShapeSnapshot): TextTarget[] {
  return shape.textStories.filter((story) => storyTextEnd(story) > 0)
    .map((story) => ({ slideId, shapeId: shape.id, storyId: story.id, start: 0, end: storyTextEnd(story) }));
}

export function shapeSteps(slideId: string, shape: ShapeSnapshot, style: ShapeStyle): PptxEditStep[] {
  if (shape.kind !== "shape") return [];
  const target = { slideId, shapeId: shape.id };
  const steps: PptxEditStep[] = [];
  if (style.fill !== undefined) steps.push({ op: "setShapeFill", target, color: style.fill });
  if (style.stroke === null) steps.push({ op: "setShapeStroke", target, stroke: { widthPt: 0 } });
  else if (style.stroke) steps.push({ op: "setShapeStroke", target, stroke: style.stroke });
  return steps;
}

/**
 * Paste a copied format onto a target: a text range takes the run style; a shape takes the shape
 * style and, when the source carried text formatting, its whole text too.
 */
export function pasteFormatSteps(format: CopiedFormat, target: { slideId: string; shape: ShapeSnapshot; range?: TextTarget | null }): PptxEditStep[] {
  const patch = textPatch(format.text);
  if (target.range) return formatSteps(target.range, patch);
  const steps = format.shape ? shapeSteps(target.slideId, target.shape, format.shape) : [];
  for (const range of shapeStoryTargets(target.slideId, target.shape)) steps.push(...formatSteps(range, patch));
  return steps;
}

/**
 * Clear formatting as far as `formatText` can: it sets values but cannot unset them, so size,
 * face and colour stay. TODO(engine): a style-reset step (`patch` with null = inherit).
 */
export const CLEAR_PATCH: TextStyle = { bold: false, italic: false, underline: "none", baselinePct: 0, spacingPt: 0 };

/** Superscript and subscript as PowerPoint writes them (`baseline` 30% / −25%). */
export const BASELINE = { superscript: 30, subscript: -25 } as const;
