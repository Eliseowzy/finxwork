import { docAttachment, fileQuote } from "../composer/attachments";
import { toComposer } from "../composer/inbox";

// Lines of a text file the person adds to the conversation from the file panel: the code editor's
// selection, or a part of a Markdown preview (§ file split view). They go to the session's composer
// as a quote; PDFs and Office files keep their own quoting (docs/state quoteToComposer).

/** Puts lines `from`–`to` of `path` (1-based), as they read now, in the session's composer. */
export function quoteLines(session: string, path: string, from: number, to: number, text: string) {
  toComposer(session, [docAttachment(fileQuote(path, from, to, text))]);
}

/** A word's plain letters: what the rendered text and its Markdown source have in common. */
const plain = (s: string) => s.replace(/[\s*_`#>|~[\]()!-]+/g, "");

/**
 * The source lines a part of a rendered Markdown file came from, when its first and last lines can
 * be found there (in order); else null, and it goes without lines.
 */
export function sourceLines(source: string, selected: string): [number, number] | null {
  const parts = selected.split("\n").map(plain).filter(Boolean);
  if (!parts.length) return null;
  const lines = source.split("\n").map(plain);
  const first = parts[0];
  const last = parts.at(-1)!;
  const start = lines.findIndex((l) => l !== "" && (l.includes(first) || first.includes(l)));
  if (start < 0) return null;
  for (let i = start; i < lines.length; i++) if (lines[i] !== "" && (lines[i].includes(last) || last.includes(lines[i]))) return [start + 1, i + 1];
  return null;
}
