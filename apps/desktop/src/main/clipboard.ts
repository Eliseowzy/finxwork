import { clipboard } from "electron";
import { fileURLToPath } from "node:url";

// What is on the clipboard for the composer's paste: the files copied in the system's file
// manager (Chromium's paste event does not carry their paths; on macOS it gets their icons),
// else a picture with no file of its own (a screenshot).

const macFilenames = 'electron application/osclipboard;format="NSFilenamesPboardType"';

/** Paths from a list of file:// URLs, one per line; anything else is left out. */
export function pathsFromUris(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("file://"))
    .flatMap((u) => {
      try {
        return [fileURLToPath(u)];
      } catch {
        return [];
      }
    });
}

/** The paths in macOS's NSFilenamesPboardType property list. */
export function pathsFromPlist(xml: string): string[] {
  const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return [...xml.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => unescape(m[1]));
}

export async function clipboardContent(): Promise<{ paths: string[]; image?: Buffer }> {
  const items = await clipboard.read();
  const text = async (item: Electron.ClipboardItem, type: string) => (item.types.includes(type) ? ((await item.getType(type)) as Blob).text() : "");
  const paths: string[] = [];
  for (const item of items) {
    const listed = pathsFromUris(await text(item, "text/uri-list"));
    paths.push(...(listed.length ? listed : pathsFromPlist(await text(item, macFilenames))));
  }
  if (paths.length) return { paths: [...new Set(paths)] };
  const picture = items.find((item) => item.types.includes("image/png"));
  if (!picture) return { paths: [] };
  return { paths: [], image: Buffer.from(await ((await picture.getType("image/png")) as Blob).arrayBuffer()) };
}
