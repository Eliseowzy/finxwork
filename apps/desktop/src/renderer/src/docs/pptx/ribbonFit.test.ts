import { test } from "node:test";
import assert from "node:assert/strict";
import { COLLAPSED, COMPACT, narrower, type RibbonFitGroup, type RibbonLevel } from "./ribbonFit.ts";

const groups: RibbonFitGroup[] = [
  { id: "slides", priority: 3, hasCompact: true },
  { id: "font", priority: 10, hasCompact: true },
  { id: "paragraph", priority: 8, hasCompact: true },
  { id: "drawing", priority: 2, hasCompact: false },
];

function steps() {
  const seen: Record<string, RibbonLevel>[] = [];
  let levels: Record<string, RibbonLevel> | null = {};
  while ((levels = narrower(groups, levels))) seen.push(levels);
  return seen;
}

test("every group drops captions before any group collapses", () => {
  const order = steps();
  const firstCollapse = order.findIndex((l) => Object.values(l).includes(COLLAPSED));
  assert.deepEqual(order[firstCollapse - 1], { slides: COMPACT, font: COMPACT, paragraph: COMPACT });
});

test("lowest priority collapses first and the most important last", () => {
  const order = steps();
  const collapsed = order.map((l) => Object.keys(l).find((id) => l[id] === COLLAPSED && !order.slice(0, order.indexOf(l)).some((p) => p[id] === COLLAPSED))).filter(Boolean);
  assert.deepEqual(collapsed, ["drawing", "slides", "paragraph", "font"]);
});

test("stops once everything is collapsed", () => {
  const all = Object.fromEntries(groups.map((g) => [g.id, COLLAPSED])) as Record<string, RibbonLevel>;
  assert.equal(narrower(groups, all), null);
});

test("among equal priorities the rightmost goes first", () => {
  const same = [{ id: "a", priority: 1, hasCompact: false }, { id: "b", priority: 1, hasCompact: false }];
  assert.deepEqual(narrower(same, {}), { b: COLLAPSED });
});
