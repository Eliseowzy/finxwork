// Pure arrange geometry in slide EMU: align, distribute and snapping. No engine calls here;
// commands turn the results into one `setShapeRect` batch (one undo step).

export type Rect = { x: number; y: number; width: number; height: number };
export type Placed = { id: string; rect: Rect };
export type AlignEdge = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";

export function bounds(rects: readonly Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width)), bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

const round = (value: number) => Math.round(value);

/** Moves every rect to one edge or centre line of `reference`; sizes never change. */
export function align(items: readonly Placed[], edge: AlignEdge, reference: Rect): Placed[] {
  return items.map(({ id, rect }) => {
    const next = { ...rect };
    if (edge === "left") next.x = reference.x;
    else if (edge === "center") next.x = reference.x + (reference.width - rect.width) / 2;
    else if (edge === "right") next.x = reference.x + reference.width - rect.width;
    else if (edge === "top") next.y = reference.y;
    else if (edge === "middle") next.y = reference.y + (reference.height - rect.height) / 2;
    else next.y = reference.y + reference.height - rect.height;
    return { id, rect: { ...next, x: round(next.x), y: round(next.y) } };
  });
}

/**
 * Equal gaps along one axis. Relative to the selection the outermost objects stay put
 * (PowerPoint needs three); relative to the page the run spans the page edge to edge.
 */
export function distribute(items: readonly Placed[], axis: DistributeAxis, page: Rect | null): Placed[] {
  const horizontal = axis === "horizontal";
  const start = (r: Rect) => horizontal ? r.x : r.y;
  const size = (r: Rect) => horizontal ? r.width : r.height;
  const sorted = [...items].sort((a, b) => start(a.rect) - start(b.rect) || a.id.localeCompare(b.id));
  if (sorted.length < (page ? 1 : 3)) return items.map((item) => ({ id: item.id, rect: { ...item.rect } }));
  // Use the outermost origins, not the union bounds: a wider middle object can
  // extend past the last object, but the two end objects must remain fixed.
  const from = page ? start(page) : start(sorted[0].rect);
  const length = page ? size(page) : start(sorted[sorted.length - 1].rect) + size(sorted[sorted.length - 1].rect) - from;
  const total = sorted.reduce((sum, item) => sum + size(item.rect), 0);
  // One object on the page centres; otherwise the outer gaps are zero, as in PowerPoint.
  const gaps = sorted.length === 1 ? 2 : sorted.length - 1;
  const gap = (length - total) / gaps;
  let cursor = from + (sorted.length === 1 ? gap : 0);
  const moved = new Map<string, Rect>();
  for (const item of sorted) {
    const rect = { ...item.rect };
    if (horizontal) rect.x = round(cursor); else rect.y = round(cursor);
    moved.set(item.id, rect);
    cursor += size(item.rect) + gap;
  }
  return items.map((item) => ({ id: item.id, rect: moved.get(item.id)! }));
}

/** Only the rects that actually change, so an aligned selection is a no-op rather than an undo step. */
export function changed(before: readonly Placed[], after: readonly Placed[]): Placed[] {
  const original = new Map(before.map((item) => [item.id, item.rect]));
  return after.filter(({ id, rect }) => {
    const old = original.get(id);
    return !old || old.x !== rect.x || old.y !== rect.y || old.width !== rect.width || old.height !== rect.height;
  });
}

export type Guide = { axis: "x" | "y"; at: number; from: number; to: number; kind: "object" | "page" };
export type Snap = { dx: number; dy: number; guides: Guide[] };

const xs = (r: Rect) => [r.x, r.x + r.width / 2, r.x + r.width];
const ys = (r: Rect) => [r.y, r.y + r.height / 2, r.y + r.height];

/**
 * Smart guides: the nearest edge or centre match of `moving` against the other objects and the
 * page centre/edges, within `threshold` EMU on each axis. Returns the correction and the lines to draw.
 */
export function snap(moving: Rect, others: readonly Rect[], page: Rect, threshold: number): Snap {
  const candidates = [...others.map((rect) => ({ rect, kind: "object" as const })), { rect: page, kind: "page" as const }];
  const pick = (axis: "x" | "y") => {
    const own = axis === "x" ? xs(moving) : ys(moving);
    let best: { delta: number; at: number; kind: Guide["kind"] } | null = null;
    for (const candidate of candidates) {
      const lines = axis === "x" ? xs(candidate.rect) : ys(candidate.rect);
      for (const line of lines) for (const mine of own) {
        const delta = line - mine;
        if (Math.abs(delta) > threshold) continue;
        if (!best || Math.abs(delta) < Math.abs(best.delta) - 0.5) best = { delta, at: line, kind: candidate.kind };
      }
    }
    return best;
  };
  const bx = pick("x"), by = pick("y");
  const dx = bx ? round(bx.delta) : 0, dy = by ? round(by.delta) : 0;
  const placed = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: Guide[] = [];
  // Draw every line the snapped rect now shares, spanning the objects that share it.
  for (const axis of ["x", "y"] as const) {
    if (!(axis === "x" ? bx : by)) continue;
    const own = axis === "x" ? xs(placed) : ys(placed);
    for (const candidate of candidates) {
      const lines = axis === "x" ? xs(candidate.rect) : ys(candidate.rect);
      for (const line of lines) {
        if (!own.some((mine) => Math.abs(mine - line) < 1)) continue;
        const span = bounds([placed, candidate.rect]);
        const [from, to] = axis === "x" ? [span.y, span.y + span.height] : [span.x, span.x + span.width];
        if (!guides.some((g) => g.axis === axis && Math.abs(g.at - line) < 1 && g.kind === candidate.kind)) guides.push({ axis, at: line, from, to, kind: candidate.kind });
      }
    }
  }
  return { dx, dy, guides };
}
