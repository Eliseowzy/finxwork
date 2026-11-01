import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, net } from "electron";
import { engineOrigin, templateOf } from "../../shared/search";

// The search engines' icons in Settings › Browser and the address field: each engine's own
// favicon, asked of its site once and kept in the app's profile, so the app ships no one's
// logo and the person's own engines get theirs too.

const MAX_BYTES = 200 * 1024;
const memory = new Map<string, Promise<string | null>>();
const dir = () => path.join(app.getPath("userData"), "search-icons");

/** A data URL of the icon of the engine with this URL template; null when its site has none to give. */
export function searchEngineIcon(template: unknown): Promise<string | null> {
  const url = typeof template === "string" ? templateOf(template) : null;
  const origin = url && engineOrigin({ url });
  if (!origin) return Promise.resolve(null);
  let icon = memory.get(origin);
  if (!icon) {
    icon = load(origin);
    memory.set(origin, icon);
  }
  return icon;
}

async function load(origin: string): Promise<string | null> {
  const file = path.join(dir(), `${crypto.createHash("sha256").update(origin).digest("hex").slice(0, 16)}.txt`);
  try {
    return fs.readFileSync(file, "utf8") || null;
  } catch {
    // Not asked yet.
  }
  const icon = await fetchIcon(`${origin}/favicon.ico`);
  // A miss is kept too (as an empty file), so the site is not asked on every visit to the page.
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file, icon ?? "");
  } catch {
    // The next start asks again.
  }
  return icon;
}

async function fetchIcon(url: string): Promise<string | null> {
  try {
    const response = await net.fetch(url, { redirect: "follow", credentials: "omit", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    const mime = type.startsWith("image/") ? type : isIco(bytes) ? "image/x-icon" : isPng(bytes) ? "image/png" : null;
    return mime ? `data:${mime};base64,${bytes.toString("base64")}` : null;
  } catch {
    return null;
  }
}

const isIco = (b: Buffer) => b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0;
const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
