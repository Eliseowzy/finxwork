import type { SlideSnapshot, ShapeSnapshot } from "@betteroffice/pptx";

function shapeLines(shape: ShapeSnapshot): string[] {
  return [
    ...shape.textStories.flatMap(story => story.paragraphs.map(p => p.runs.map(r => r.text).join("").trim()).filter(Boolean)),
    ...shape.children.flatMap(shapeLines),
  ];
}

export function outlineLines(slide: SlideSnapshot): string[] {
  return slide.shapes.flatMap(shapeLines);
}
