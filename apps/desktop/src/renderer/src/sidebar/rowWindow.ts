import { useLayoutEffect, useRef, useState } from "react";

// A thousand sessions or bots draw a few screens of rows, not a thousand: each block of equal
// rows draws those in sight, with a screen of margin each way, and stands in for the others
// with space before and after them. The rows stay in the list's flow, so sticky headings, the
// gaps between rows and the list's height are what they would be with every row drawn.

/** How far one row starts from the next, and the gap between them (measured from two drawn rows). */
export type RowPitch = { pitch: number; gap: number };

/** Rows drawn per step as the list scrolls: the window moves by whole steps, not by every row. */
const STEP = 12;

/**
 * The rows of a block in sight, [first, end): `top` is where its first row starts in the
 * scroller's content. Read again as the list scrolls or resizes and on each render (a group
 * above may have opened or closed); it changes only when it moves by a step. The scroller is
 * the element itself, kept in state by the list (a callback ref): a block inside it runs its
 * effects before the list's ref is set, so a ref object would still be empty there.
 */
export function useRowWindow(el: HTMLElement | null, top: () => number | null, count: number, { pitch }: RowPitch): [number, number] {
  // Nothing until the first layout says what is in sight, before the first paint.
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const update = useRef(() => {});
  update.current = () => {
    const at = el && top();
    if (!el || at === null) return;
    const margin = el.clientHeight;
    const from = el.scrollTop - margin - at;
    const to = el.scrollTop + el.clientHeight + margin - at;
    const first = Math.max(0, Math.min(count, Math.floor(from / pitch / STEP) * STEP));
    const end = Math.max(first, Math.min(count, Math.ceil(to / pitch / STEP) * STEP));
    setRange((r) => (r[0] === first && r[1] === end ? r : [first, end]));
  };
  // Each render: a block above may have opened or closed, or rows come and gone.
  useLayoutEffect(() => update.current());
  useLayoutEffect(() => {
    if (!el) return;
    const on = () => update.current();
    el.addEventListener("scroll", on, { passive: true });
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", on);
      ro.disconnect();
    };
  }, [el]);
  return [Math.min(range[0], count), Math.min(range[1], count)];
}

/** The space that stands in for `n` rows not drawn, as one flex item among the rows (its own gap counted). */
export function spacer(n: number, { pitch, gap }: RowPitch): number {
  return n > 0 ? n * pitch - gap : 0;
}

/**
 * The pitch of the rows as drawn: two neighbouring rows matching `selector` under the scroller,
 * else what it was. Kept in state by the list, so a change of view (rows with a second line) is measured again.
 */
export function measurePitch(scroller: HTMLElement | null, selector: string, was: RowPitch): RowPitch {
  const rows = scroller?.querySelectorAll<HTMLElement>(selector);
  if (!rows || rows.length < 2) return was;
  const [a, b] = [rows[0]!, rows[1]!];
  if (a.nextElementSibling !== b) return was;
  const pitch = b.offsetTop - a.offsetTop;
  const gap = pitch - a.offsetHeight;
  return pitch > 0 && (pitch !== was.pitch || gap !== was.gap) ? { pitch, gap } : was;
}
