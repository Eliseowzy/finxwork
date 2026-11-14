import fs from "node:fs";
import path from "node:path";

// What finxdoc:// answers to (main/docs.ts), kept apart from Electron to be tested.

/** The working copy or spatial cache file a token stands for, or null. */
export function tokenFile(home: string, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{32}$/.test(u.host)) return null;
  const docs = path.join(home, "docs");
  let id: string;
  try {
    id = fs.readFileSync(path.join(docs, ".tokens", u.host), "utf8").trim();
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  if (u.pathname === "/current.pdf") return path.join(docs, id, "current.pdf");
  const spatial = path.join(home, "cache", "spatial", id);
  if (u.pathname === "/spatial/index.json") return path.join(spatial, "volume", "index.json");
  if (u.pathname === "/spatial/bricks.bin") return path.join(spatial, "volume", "bricks.bin");
  const mesh = /^\/spatial\/mesh\/([A-Za-z0-9._-]+)\/(\d+)\.bin$/.exec(u.pathname);
  if (mesh && mesh[1] !== "." && mesh[1] !== "..") {
    return path.join(spatial, "mesh", mesh[1], `${mesh[2]}.bin`);
  }
  return null;
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
