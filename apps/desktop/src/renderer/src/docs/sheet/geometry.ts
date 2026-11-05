import { useCallback, useMemo } from "react";
import type { SheetInfo } from "@finx/protocol";

// Where the grid's columns and rows are, in CSS pixels at zoom 1: the file's widths and heights,
// with what was dragged here over them. Rows are mostly the default height, so only the rows that
// differ are kept, and a row's top is found by binary search over them.

export type Geometry = {
  widths: number[];
  /** colLeft[c]: the left of column c; colLeft[nCols + 1] the grid's width. */
  colLeft: number[];
  defaultHeight: number;
  rowY: (row: number) => number;
  rowAt: (y: number) => number;
  colAt: (x: number) => number;
};

export function useGeometry(args: {
  sheet: SheetInfo | undefined;
  nCols: number;
  nRows: number;
  /** Column widths and row heights dragged here, for this sheet. */
  colSizes: Map<number, number>;
  rowSizes: Map<number, number>;
  /** Row heights read from the file so far, and a stamp that changes when they do. */
  heights: Map<number, number>;
  heightsStamp: string;
}): Geometry {
  const { sheet, nCols, nRows, colSizes, rowSizes, heights, heightsStamp } = args;
  const widths = useMemo(() => {
    const w: number[] = new Array(nCols + 1).fill(sheet?.default_width ?? 64);
    for (const c of sheet?.columns ?? []) for (let i = c.first; i <= Math.min(c.last, nCols); i++) w[i] = c.hidden ? 0 : c.width;
    for (const [c, v] of colSizes) if (c <= nCols) w[c] = v;
    return w;
  }, [sheet, nCols, colSizes]);
  const colLeft = useMemo(() => {
    const x = [0, 0];
    for (let c = 1; c <= nCols; c++) x[c + 1] = x[c] + widths[c];
    return x;
  }, [widths, nCols]);
  const defaultHeight = sheet?.default_height ?? 20;
  const rows = useMemo(() => {
    const merged = new Map(heights);
    for (const [r, v] of rowSizes) merged.set(r, v);
    const sorted = [...merged.entries()].filter(([r]) => r <= nRows).sort((a, b) => a[0] - b[0]);
    const extra = [0];
    for (const [, height] of sorted) extra.push(extra[extra.length - 1] + height - defaultHeight);
    return { sorted, extra };
    // `heights` is the cache's own map, changed in place: its stamp says when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nRows, defaultHeight, heightsStamp, rowSizes]);
  const rowY = useCallback(
    (row: number) => {
      let lo = 0;
      let hi = rows.sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rows.sorted[mid][0] < row) lo = mid + 1;
        else hi = mid;
      }
      return Math.max(0, row - 1) * defaultHeight + rows.extra[lo];
    },
    [rows, defaultHeight],
  );
  const rowAt = useCallback(
    (y: number) => {
      let lo = 1;
      let hi = nRows;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (rowY(mid) <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [rowY, nRows],
  );
  // The last column whose left is at or before x.
  const colAt = useCallback(
    (x: number) => {
      let lo = 1;
      let hi = nCols;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (colLeft[mid] <= x) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [colLeft, nCols],
  );
  return { widths, colLeft, defaultHeight, rowY, rowAt, colAt };
}
