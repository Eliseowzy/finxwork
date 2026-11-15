import { useEffect, type RefObject } from "react";

// "@Name" in group messages, drawn in the accent blue. The CSS Highlight API colours the ranges
// without touching the nodes React (and the Markdown renderer) own; one registry entry is shared
// by every list that draws group messages.

const NAME = "group-mention";
const lists = new Map<symbol, Range[]>();

function redraw() {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!registry || !H) return;
  registry.set(NAME, new H(...[...lists.values()].flat()));
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Colours "@<member name>" inside the message bubbles under `root`. */
export function useMentionHighlight(root: RefObject<HTMLElement | null>, names: string[]) {
  const key = names.join("\u0000");
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const id = Symbol();
    const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
    const pattern = sorted.length ? new RegExp(`@(?:${sorted.map(escape).join("|")})`, "g") : null;
    let frame = 0;
    const scan = () => {
      frame = 0;
      const ranges: Range[] = [];
      if (pattern) {
        for (const bubble of el.querySelectorAll(".bub, .bbub")) {
          const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.parentElement?.closest("code, pre")) continue;
            const text = node.nodeValue ?? "";
            for (const m of text.matchAll(pattern)) {
              const r = new Range();
              r.setStart(node, m.index);
              r.setEnd(node, m.index + m[0].length);
              ranges.push(r);
            }
          }
        }
      }
      lists.set(id, ranges);
      redraw();
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(scan);
    };
    scan();
    const watch = new MutationObserver(later);
    watch.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      watch.disconnect();
      cancelAnimationFrame(frame);
      lists.delete(id);
      redraw();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, key]);
}
