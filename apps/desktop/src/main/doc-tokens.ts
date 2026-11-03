import fs from "node:fs";
import path from "node:path";

// What finxdoc:// answers to (main/docs.ts), kept apart from Electron to be tested.

/** The working copy a token stands for, or null. */
export function tokenFile(home: string, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{32}$/.test(u.host) || u.pathname !== "/current.pdf") return null;
  const docs = path.join(home, "docs");
  let id: string;
  try {
    id = fs.readFileSync(path.join(docs, ".tokens", u.host), "utf8").trim();
  } catch {
    return null;
  }
  return /^[0-9a-f]{16}$/.test(id) ? path.join(docs, id, "current.pdf") : null;
}

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` within `size`, or null for the whole file. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "bad" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  let start: number;
  let end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? "bad" : { start, end };
}
