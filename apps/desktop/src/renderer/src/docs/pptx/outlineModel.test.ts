import { strict as assert } from "node:assert";
import { test } from "node:test";
import { outlineLines } from "./outlineModel.ts";
import type { SlideSnapshot, ShapeSnapshot } from "@nimbleoffice/pptx";

function shape(lines: string[][], children: ShapeSnapshot[] = []): ShapeSnapshot {
  return { textStories: [{ paragraphs: lines.map(runs => ({ runs: runs.map(text => ({ text })) })) }], children } as unknown as ShapeSnapshot;
}

test("outline joins text runs and visits grouped objects in order", () => {
  const slide = { shapes: [shape([["Hello", " world"], [" "]], [shape([["Nested"]])]), shape([["Final"]])] } as SlideSnapshot;
  assert.deepEqual(outlineLines(slide), ["Hello world", "Nested", "Final"]);
});

test("outline handles slides without text", () => {
  assert.deepEqual(outlineLines({ shapes: [] } as unknown as SlideSnapshot), []);
});
