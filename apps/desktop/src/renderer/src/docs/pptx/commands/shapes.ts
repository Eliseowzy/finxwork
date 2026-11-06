// The shape gallery. `placeable` shapes go through the editor's own placement tool (click or drag
// on the slide, as in PowerPoint); the 0.5.1 tool accepts only these presets. The rest need
// `addShape` with any `prst` (and connectors for lines) on the editor access: TODO(engine).

export type ShapeCategory = "lines" | "basic" | "arrows" | "flowchart" | "callouts" | "stars";
export type ShapeEntry = { geometry: string; category: ShapeCategory; placeable: boolean; icon: string };

// 20×20 outline icons, drawn for the gallery only.
const P = {
  line: "M3 17 17 3",
  arrowLine: "M3 17 16 4M10 4h6v6",
  elbow: "M3 16h7V4h7",
  rect: "M3 5h14v10H3z",
  roundRect: "M6 5h8a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z",
  ellipse: "M10 4c4 0 7 2.7 7 6s-3 6-7 6-7-2.7-7-6 3-6 7-6z",
  triangle: "M10 3l7 14H3z",
  rtTriangle: "M3 3v14h14z",
  diamond: "M10 2l8 8-8 8-8-8z",
  parallelogram: "M6 5h11l-3 10H3z",
  trapezoid: "M6 5h8l3 10H3z",
  pentagon: "M10 2l8 6-3 9H5L2 8z",
  hexagon: "M6 3h8l4 7-4 7H6l-4-7z",
  octagon: "M7 2h6l5 5v6l-5 5H7l-5-5V7z",
  heart: "M10 17S2 12 2 7a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 5-8 10-8 10z",
  can: "M4 5c0-1.7 12-1.7 12 0v10c0 1.7-12 1.7-12 0zM4 5c0 1.7 12 1.7 12 0",
  rightArrow: "M2 7h9V3l7 7-7 7v-4H2z",
  leftArrow: "M18 7H9V3l-7 7 7 7v-4h9z",
  upArrow: "M7 18V9H3l7-7 7 7h-4v9z",
  downArrow: "M7 2v9H3l7 7 7-7h-4V2z",
  leftRightArrow: "M1 10l5-5v3h8V5l5 5-5 5v-3H6v3z",
  upDownArrow: "M10 1l5 5h-3v8h3l-5 5-5-5h3V6H5z",
  chevron: "M3 4h9l5 6-5 6H3l5-6z",
  flowChartProcess: "M2 5h16v10H2z",
  flowChartAlternateProcess: "M5 5h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
  flowChartDecision: "M10 3l8 7-8 7-8-7z",
  flowChartTerminator: "M7 6h6a4 4 0 0 1 0 8H7a4 4 0 0 1 0-8z",
  flowChartDocument: "M3 4h14v10c-4-3-10 3-14 0z",
  flowChartPredefinedProcess: "M2 5h16v10H2zM5 5v10M15 5v10",
  wedgeRectCallout: "M2 3h16v10H9l-4 4v-4H2z",
  wedgeRoundRectCallout: "M5 3h10a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H9l-4 4v-4a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z",
  wedgeEllipseCallout: "M10 3c4.4 0 8 2.5 8 5.5S14.4 14 10 14H8l-4 4 1-4.6C3.2 12.4 2 10.5 2 8.5 2 5.5 5.6 3 10 3z",
  star5: "M10 2l2.4 5.2 5.6.6-4.2 3.8 1.2 5.6L10 14.3 5 17.2l1.2-5.6L2 7.8l5.6-.6z",
  star4: "M10 2l2 6 6 2-6 2-2 6-2-6-6-2 6-2z",
} as const;

const PLACEABLE = new Set(["rect", "roundRect", "ellipse", "triangle", "rtTriangle", "diamond", "parallelogram", "trapezoid", "pentagon", "hexagon", "octagon", "star5", "rightArrow", "leftArrow", "upArrow", "downArrow", "chevron"]);

const entry = (geometry: keyof typeof P, category: ShapeCategory): ShapeEntry => ({ geometry, category, placeable: PLACEABLE.has(geometry), icon: P[geometry] });

export const SHAPE_LIBRARY: readonly ShapeEntry[] = [
  entry("line", "lines"), entry("arrowLine", "lines"), entry("elbow", "lines"),
  ...(["rect", "roundRect", "ellipse", "triangle", "rtTriangle", "diamond", "parallelogram", "trapezoid", "pentagon", "hexagon", "octagon", "heart", "can"] as const).map((g) => entry(g, "basic")),
  ...(["rightArrow", "leftArrow", "upArrow", "downArrow", "leftRightArrow", "upDownArrow", "chevron"] as const).map((g) => entry(g, "arrows")),
  ...(["flowChartProcess", "flowChartAlternateProcess", "flowChartDecision", "flowChartTerminator", "flowChartDocument", "flowChartPredefinedProcess"] as const).map((g) => entry(g, "flowchart")),
  ...(["wedgeRectCallout", "wedgeRoundRectCallout", "wedgeEllipseCallout"] as const).map((g) => entry(g, "callouts")),
  ...(["star5", "star4"] as const).map((g) => entry(g, "stars")),
];

export const SHAPE_CATEGORIES: readonly ShapeCategory[] = ["lines", "basic", "arrows", "flowchart", "callouts", "stars"];
