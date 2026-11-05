import { attachedBlock, baseName, docQuoteBlock, userText, webCommentBlock, type DocQuote, type HandedTabs, type WebComment } from "@finx/client";
import type { UserContent } from "@finx/protocol";
import type { PickedFile } from "../../../shared/bridge";
import { i18n } from "../../../shared/i18n.ts";

// What the composer's "+" adds to a message: images, which go as the
// protocol's image content; files, which go by path; folders, which go by
// path too, or as more workspace roots of a new session (extra_roots).

export type Attachment = PickedFile | { kind: "folder"; path: string; name: string } | WebAttachment | DocAttachment | TabsAttachment;

/** Browser tabs a message handed over, back in the composer: the block goes along as it was. */
export type TabsAttachment = { kind: "tabs"; path: string; name: string; block: string };

/** What a tile of handed-over tabs is called: the tab's title, or how many. */
export const tabsName = (tabs: HandedTabs) => (tabs.titles.length === 1 && tabs.titles[0] ? tabs.titles[0] : i18n.t("session:composer.tabs", { count: tabs.titles.length }));

/** A part of a document quoted from the document column; its path only tells it apart from the others. image: a region's picture (PNG, base64), which goes along as an image. */
export type DocAttachment = { kind: "doc"; path: string; name: string; quote: DocQuote; image?: string };

/** What a quote's tile is called: what was said about it, else its text, else its document. */
export const quoteName = (q: DocQuote) => q.comment || (q.sheet && q.range ? `${q.sheet}!${q.range}` : q.text) || baseName(q.path);
/** What a part of a page's tile is called: what was said about it, else its text, else its tag. */
export const webName = (c: WebComment) => c.comment || c.text || `<${c.tag}>`;

let docCount = 0;
export function docAttachment(quote: DocQuote, image?: string): DocAttachment {
  // The image's place in a message is the message's to say (toInput), not the quote's.
  const { image: _, ...q } = quote;
  return { kind: "doc", path: `doc:${++docCount}:${q.doc_id}:${q.page ?? `${q.sheet}!${q.range}`}`, name: quoteName(q), quote: q, ...(image && { image }) };
}

/** A message's images paired with the parts of pages and documents they show (their `image`, from 1); the rest show on their own. */
export function pairImages<I>(parts: { image?: number }[], images: I[]): { pictures: (I | undefined)[]; rest: I[] } {
  const pictures = parts.map((p) => (p.image ? images[p.image - 1] : undefined));
  const taken = new Set(parts.flatMap((p) => (p.image && images[p.image - 1] ? [p.image - 1] : [])));
  return { pictures, rest: images.filter((_, i) => !taken.has(i)) };
}

/** A part of a page added from the browser panel; its path only tells it apart from the others. image: what it looks like (PNG, base64), which goes along as an image. */
export type WebAttachment = { kind: "web"; path: string; name: string; comment: WebComment; image?: string };

let webCount = 0;
export function webAttachment(comment: WebComment, image?: string): WebAttachment {
  const { image: _, ...c } = comment;
  return { kind: "web", path: `web:${++webCount}:${c.url}`, name: webName(c), comment: c, ...(image && { image }) };
}

/** The window event that asks the composer on screen to attach (the menu's Add Files…, ⌘U). */
export const attachEvent = "finx-attach";

/** Files with no path known (a page previewed in a browser): images read, the rest by name. */
function fromFiles(files: File[]): Promise<Attachment[]> {
  return Promise.all(
    files.map(async (f): Promise<Attachment> =>
      f.type.startsWith("image/") ? { kind: "image", path: `${f.name}:${f.size}:${f.lastModified}`, name: f.name, mime_type: f.type, data: await base64(f) } : { kind: "file", path: f.name, name: f.name },
    ),
  );
}

/** Files from the system's dialog; a page previewed in a browser uses its own picker. */
export async function pickFiles(): Promise<Attachment[]> {
  if (window.finx) return window.finx.pickFiles();
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => resolve(await fromFiles([...(input.files ?? [])]));
    input.click();
  });
}

/** What a drop attaches: the window reads the dropped files and folders by their paths; a page previewed in a browser has only the files. */
export function droppedAttachments(data: DataTransfer): Promise<Attachment[]> {
  const files = [...data.files];
  if (!window.finx) return fromFiles(files);
  const paths = files.map((f) => window.finx!.pathForFile(f)).filter(Boolean);
  return paths.length ? window.finx.attachPaths(paths) : fromFiles(files);
}

/**
 * What a paste attaches, or null when it is only text (and pastes as text). The window reads the
 * files copied in the file manager, or the clipboard's picture; a page previewed in a browser
 * has only the paste's own files.
 */
export function pastedAttachments(data: DataTransfer): Promise<Attachment[]> | null {
  if (!data.types.includes("Files")) return null;
  const files = [...data.files];
  return window.finx ? window.finx.pasteFiles().then((got) => (got.length ? got : fromFiles(files))) : fromFiles(files);
}

export async function pickFolder(): Promise<Attachment | null> {
  const dir = window.finx ? await window.finx.pickDirectory() : window.prompt(i18n.t("session:new.pathPrompt"));
  return dir ? { kind: "folder", path: dir, name: baseName(dir) } : null;
}

async function base64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The list with more added; one already there (the same path) is not added twice. */
export function addAttachments(list: Attachment[], more: Attachment[]): Attachment[] {
  const have = new Set(list.map((a) => a.path));
  return [...list, ...more.filter((a) => !have.has(a.path))];
}

/** A message's content: its words, its images, a block naming its files and folders (a folder's path ends in a separator), then the parts of pages. */
export function toInput(text: string, atts: Attachment[]): UserContent[] {
  const out: UserContent[] = [];
  if (text.trim() !== "") out.push({ type: "text", text: text.trim() });
  // A part of a page's or a document's picture goes as an image; the part says which one (from 1).
  const pictured = new Map<Attachment, number>();
  for (const a of atts) {
    if (a.kind === "image") out.push({ type: "image", mime_type: a.mime_type, data: a.data });
    else if ((a.kind === "doc" || a.kind === "web") && a.image) (out.push({ type: "image", mime_type: "image/png", data: a.image }), pictured.set(a, out.filter((c) => c.type === "image").length));
  }
  const numbered = <T,>(a: Attachment, part: T) => (pictured.has(a) ? { ...part, image: pictured.get(a) } : part);
  const paths = atts.flatMap((a) => (a.kind === "file" ? [a.path] : a.kind === "folder" ? [/[\\/]$/.test(a.path) ? a.path : a.path + "/"] : []));
  if (paths.length) out.push(attachedBlock(paths));
  const web = atts.flatMap((a) => (a.kind === "web" ? [numbered(a, a.comment)] : []));
  if (web.length) out.push(webCommentBlock(web));
  const quotes = atts.flatMap((a) => (a.kind === "doc" ? [numbered(a, a.quote)] : []));
  if (quotes.length) out.push(docQuoteBlock(quotes));
  for (const a of atts) if (a.kind === "tabs") out.push({ type: "text", text: a.block });
  return out;
}

let returnedCount = 0;

/** A message's content back as the composer had it (toInput the other way): for what a stopped task hands back, a waiting message taken back to edit, or a sent one written again. */
export function fromInput(content: UserContent[]): { text: string; attachments: Attachment[] } {
  const { text, files, comments, quotes, tabs } = userText(content);
  const { pictures, rest } = pairImages([...comments, ...quotes], content.flatMap((c) => (c.type === "image" ? [c] : [])));
  const images = rest.map((c): Attachment => {
    const name = i18n.t("session:queued.image", { n: ++returnedCount });
    return { kind: "image", path: `returned:${returnedCount}`, name, mime_type: c.mime_type, data: c.data };
  });
  const paths = files.map((p): Attachment => {
    const folder = /[\\/]$/.test(p);
    const path = folder ? p.slice(0, -1) : p;
    return { kind: folder ? "folder" : "file", path, name: baseName(path) };
  });
  return { text, attachments: [...images, ...paths, ...comments.map((c, i) => webAttachment(c, pictures[i]?.data)), ...quotes.map((q, i) => docAttachment(q, pictures[comments.length + i]?.data)), ...tabs.map((b): Attachment => ({ kind: "tabs", path: `tabs:${b.text}`, name: tabsName(b), block: b.text }))] };
}
