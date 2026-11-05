import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import { texMath } from "./tex.ts";

// The same grammar as the renderer. Keep the last AST block open: a paragraph can
// become a heading/table, and lists/quotes can continue after a blank line.
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath, { singleDollarTextMath: false }).use(remarkDirective).use(texMath);
export type MarkdownSlice = { id: number; text: string; pending: boolean };

// References are document scoped, including references whose definitions arrive
// later. Parse those documents together instead of freezing unresolved links.
const references = /\[[^\]\n]+\](?!\(|$)/;
function hasReferences(text: string) {
  let fence = "";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && !fence && !(marker[1][0] === "`" && marker[2].includes("`"))) { fence = marker[1]; continue; }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
      continue;
    }
    // Be conservative about inline code: unmatched backticks are ordinary text,
    // and must not hide a later reference definition from the document parser.
    const prose = line.replace(/\\./g, " ")
      .replace(/^(\s*>\s*)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/, "$1")
      .replace(/^(\s*(?:[-+*]|\d+[.)])\s+)\[[ xX]\]/, "$1");
    if (references.test(prose + (i < lines.length - 1 ? "\n" : ""))) return true;
  }
  return false;
}

export function createMarkdownSlices() {
  let previous = "";
  let prefix: MarkdownSlice[] = [];
  let offset = 0;
  return (text: string, streaming: boolean): MarkdownSlice[] => {
    if (!text.startsWith(previous)) { prefix = []; offset = 0; }
    previous = text;
    if (hasReferences(text)) {
      prefix = []; offset = 0;
      return [{ id: 0, text, pending: streaming }];
    }
    const tail = text.slice(offset);
    const nodes = parser.parse(tail).children;
    // Retain two AST nodes for lookbehind: an arriving "2" is initially a
    // paragraph, but "2. next" can still join the preceding loose list.
    const keepFrom = Math.max(0, nodes.length - 2);
    const boundary = keepFrom ? nodes[keepFrom].position!.start.offset! : 0;
    const slices = nodes.map((node, i) => {
      const start = i === 0 ? 0 : node.position!.start.offset!;
      const end = nodes[i + 1]?.position?.start.offset ?? tail.length;
      return { id: offset + start, text: tail.slice(start, end), pending: streaming && i === nodes.length - 1 };
    });
    prefix = [...prefix, ...slices.slice(0, keepFrom).map((slice) => ({ ...slice, pending: false }))];
    offset += boundary;
    return [...prefix, ...slices.slice(keepFrom)];
  };
}

/** Only suppress a provisional table outside a fenced block. Escaped pipes and
 * pipes in inline code belong to a cell, not to the column count. */
export function pendingText(text: string): string {
  const nodes = parser.parse(text).children;
  const last = nodes.at(-1);
  if (last?.type !== "paragraph") return text;
  const start = last.position!.start.offset!;
  const tail = text.slice(start);
  return /^\s*\|[^\n]*\n?$/.test(tail) ? text.slice(0, start) : text;
}
