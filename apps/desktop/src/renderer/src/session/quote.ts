import type { MessageQuote } from "@finx/client";

// Where a message quote's jump lands (message-quote-design §4.6): the quoted words found among a
// row's text and lit up for a moment, or the row flashed when they are not there (a whole quote,
// or words the reply no longer has).

/** What a selection is in: a step's key and whose words they are. */
export type QuotablePart = { key: string; role: string };

/** The quote a selection makes (§4.2, D-642): both ends in one quotable part, or none. */
export function selectionQuoteOf(anchor: QuotablePart | null, focus: QuotablePart | null, text: string): MessageQuote | null {
  if (!anchor || !focus || anchor.key !== focus.key || anchor.role !== focus.role) return null;
  if (anchor.role !== "assistant" && anchor.role !== "user") return null;
  const words = text.trim();
  return words === "" ? null : { role: anchor.role, text: words, key: anchor.key };
}

/** The parts of a row a selection may point at: a reply's Markdown, or the owner's bubble. */
export const quotable = ".md, .bub";

type Piece = { node: Text; at: number; end: number };

/** Elements that start a line of their own, as the browser's own selected text has them. */
const blocks = new Set(["P", "DIV", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "DETAILS", "SUMMARY", "FIGURE", "FIGCAPTION", "SECTION", "ARTICLE", "HEADER", "FOOTER", "HR", "DD", "DT"]);
/** The copies of code blocks' and tables' toolbars: they are buttons, not the reply's words. */
const chrome = ".cb-h, .md-tools";

/** A row's words as the conversation shows them, with each text node's place in them. */
function words(root: HTMLElement): { text: string; pieces: Piece[] } {
  const pieces: Piece[] = [];
  let text = "";
  const line = () => {
    if (text !== "" && !text.endsWith("\n")) text += "\n";
  };
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const data = (child as Text).data;
        if (data === "") continue;
        pieces.push({ node: child as Text, at: text.length, end: text.length + data.length });
        text += data;
      } else if (child instanceof Element) {
        if (child.matches(chrome)) continue;
        if (child.tagName === "BR") {
          line();
          continue;
        }
        const block = blocks.has(child.tagName);
        if (block) line();
        walk(child);
        if (block) line();
      }
    }
  };
  walk(root);
  return { text, pieces };
}

/** The text with each run of spaces, tabs and newlines as one space, and where each of its letters was. */
function squeezed(text: string): { text: string; at: number[] } {
  let out = "";
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (space) continue;
      space = true;
      out += " ";
    } else {
      space = false;
      out += c;
    }
    at.push(i);
  }
  return { text: out, at };
}

function pointAt(pieces: Piece[], offset: number, end: boolean): { node: Text; offset: number } | null {
  const pos = end ? offset - 1 : offset;
  if (pos < 0) return null;
  for (const p of pieces) if (pos >= p.at && pos < p.end) return { node: p.node, offset: end ? pos - p.at + 1 : pos - p.at };
  return null;
}

/** The words found in a row, as a range: exactly when they are there as they were selected, else with whitespace taken loosely (§4.6). */
export function locateQuote(root: HTMLElement, want: string): Range | null {
  const needle = want.trim();
  if (needle === "") return null;
  const { text, pieces } = words(root);
  let start = text.indexOf(needle);
  let end = start < 0 ? -1 : start + needle.length;
  if (start < 0) {
    const hay = squeezed(text);
    const find = squeezed(needle);
    const at = hay.text.indexOf(find.text);
    if (at < 0) return null;
    start = hay.at[at];
    end = hay.at[at + find.text.length - 1] + 1;
  }
  const from = pointAt(pieces, start, false);
  const to = pointAt(pieces, end, true);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range.collapsed ? null : range;
}

const shown = "finx-quote";
let cleanup: (() => void) | null = null;

/** Puts the quoted words in the middle of the conversation and lights them, or flashes the row; a moment later it goes. */
export function markQuote(row: HTMLElement, q: MessageQuote): void {
  clearQuoteMark();
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = row.querySelector<HTMLElement>(quotable);
  const range = root && !q.whole && q.text !== "" ? locateQuote(root, q.text) : null;
  if (!range) {
    if (still) return;
    row.classList.add("qflash");
    const timer = window.setTimeout(() => row.classList.remove("qflash"), 1400);
    cleanup = () => {
      clearTimeout(timer);
      row.classList.remove("qflash");
    };
    return;
  }
  CSS.highlights.set(shown, new Highlight(range));
  const scroller = row.closest<HTMLElement>(".cscroll");
  const r = range.getBoundingClientRect();
  if (scroller && (r.width || r.height)) scroller.scrollTop += r.top - scroller.getBoundingClientRect().top - scroller.clientHeight / 2 + r.height / 2;
  const timer = window.setTimeout(clearQuoteMark, 2000);
  const off = () => clearQuoteMark();
  cleanup = () => {
    clearTimeout(timer);
    CSS.highlights.delete(shown);
    scroller?.removeEventListener("pointerdown", off);
    scroller?.removeEventListener("wheel", off);
    scroller?.removeEventListener("keydown", off);
    scroller?.removeEventListener("touchmove", off);
  };
  // A press, a key or a scroll of the conversation takes the light away at once.
  if (scroller) {
    scroller.addEventListener("pointerdown", off);
    scroller.addEventListener("wheel", off, { passive: true });
    scroller.addEventListener("keydown", off);
    scroller.addEventListener("touchmove", off, { passive: true });
  }
}

/** Takes the quote's light or flash away early. */
export function clearQuoteMark(): void {
  cleanup?.();
  cleanup = null;
}
