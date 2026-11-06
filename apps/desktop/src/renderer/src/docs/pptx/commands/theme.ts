// Reads the package parts the 0.5.1 editor API does not expose: the theme colour scheme and
// the slide layouts' names. Read-only, from the opened bytes. TODO(engine): replace with
// `layouts()` / a theme read on the editor access once the fork exposes them.

export type ThemeColors = Record<"dk1" | "lt1" | "dk2" | "lt2" | "accent1" | "accent2" | "accent3" | "accent4" | "accent5" | "accent6" | "hlink" | "folHlink", string>;
export type LayoutInfo = { partPath: string; name: string | null; type: string | null };

/** Office 2013–2022 theme, used when a deck carries no theme part. */
export const OFFICE_THEME: ThemeColors = {
  dk1: "#000000", lt1: "#FFFFFF", dk2: "#44546A", lt2: "#E7E6E6",
  accent1: "#4472C4", accent2: "#ED7D31", accent3: "#A5A5A5", accent4: "#FFC000", accent5: "#5B9BD5", accent6: "#70AD47",
  hlink: "#0563C1", folHlink: "#954F72",
};

type Entry = { name: string; method: number; compressed: number; offset: number };

function entries(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: scan back over a possible comment (≤ 64 KiB).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const result: Entry[] = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true), compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    result.push({ name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)), method, compressed, offset });
    at += 46 + nameLength + extra + comment;
  }
  return result;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function read(bytes: Uint8Array, entry: Entry): Promise<string | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.offset, true) !== 0x04034b50) return null;
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.compressed);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) return null;
  return new TextDecoder().decode(await inflate(data));
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

export function parseThemeColors(xml: string): ThemeColors {
  const scheme = /<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/.exec(xml)?.[0];
  const colors = { ...OFFICE_THEME };
  if (!scheme) return colors;
  for (const key of Object.keys(colors) as (keyof ThemeColors)[]) {
    const body = new RegExp(`<a:${key}>([\\s\\S]*?)</a:${key}>`).exec(scheme)?.[1];
    if (!body) continue;
    const tag = /<a:(srgbClr|sysClr)\b[^>]*>/.exec(body)?.[0];
    const value = tag ? (tag.startsWith("<a:srgbClr") ? attr(tag, "val") : attr(tag, "lastClr")) : null;
    if (value && /^[0-9a-f]{6}$/i.test(value)) colors[key] = `#${value.toUpperCase()}`;
  }
  return colors;
}

export function parseLayout(partPath: string, xml: string): LayoutInfo {
  const root = /<p:sldLayout\b[^>]*>/.exec(xml)?.[0] ?? "";
  const cSld = /<p:cSld\b[^>]*>/.exec(xml)?.[0] ?? "";
  const decode = (value: string | null) => value?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&") ?? null;
  return { partPath, name: decode(attr(cSld, "name")), type: attr(root, "type") };
}

const layoutNumber = (path: string) => Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0);

/** Theme colours and every slide layout in package order. Never throws: a bad package reads as empty. */
export async function readPackageInfo(bytes: Uint8Array): Promise<{ theme: ThemeColors; layouts: LayoutInfo[] }> {
  try {
    const list = entries(bytes);
    const themeEntry = list.filter((e) => /^ppt\/theme\/theme\d+\.xml$/.test(e.name)).sort((a, b) => layoutNumber(a.name) - layoutNumber(b.name))[0];
    const theme = themeEntry ? parseThemeColors((await read(bytes, themeEntry)) ?? "") : { ...OFFICE_THEME };
    const layouts: LayoutInfo[] = [];
    for (const entry of list.filter((e) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(e.name)).sort((a, b) => layoutNumber(a.name) - layoutNumber(b.name))) {
      const xml = await read(bytes, entry);
      if (xml) layouts.push(parseLayout(entry.name, xml));
    }
    return { theme, layouts };
  } catch {
    return { theme: { ...OFFICE_THEME }, layouts: [] };
  }
}
