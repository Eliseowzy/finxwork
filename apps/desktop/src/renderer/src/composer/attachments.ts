import { attachedBlock, baseName, webCommentBlock, type WebComment } from "@finx/client";
import type { UserContent } from "@finx/protocol";
import type { PickedFile } from "../../../shared/bridge";
import { i18n } from "../../../shared/i18n";

// What the composer's "+" adds to a message: images, which go as the
// protocol's image content; files, which go by path; folders, which go by
// path too, or as more workspace roots of a new session (extra_roots).

export type Attachment = PickedFile | { kind: "folder"; path: string; name: string } | WebAttachment;

/** A part of a page added from the browser panel; its path only tells it apart from the others. */
export type WebAttachment = { kind: "web"; path: string; name: string; comment: WebComment };

let webCount = 0;
export function webAttachment(comment: WebComment): WebAttachment {
  return { kind: "web", path: `web:${++webCount}:${comment.url}`, name: comment.comment || comment.text || `<${comment.tag}>`, comment };
}

/** The window event that asks the composer on screen to attach (the menu's Add Files…, ⌘U). */
export const attachEvent = "finx-attach";

/** Files from the system's dialog; a page previewed in a browser uses its own picker (images read, no paths). */
export async function pickFiles(): Promise<Attachment[]> {
  if (window.finx) return window.finx.pickFiles();
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      resolve(
        await Promise.all(
          files.map(async (f): Promise<Attachment> =>
            f.type.startsWith("image/") ? { kind: "image", path: f.name, name: f.name, mime_type: f.type, data: await base64(f) } : { kind: "file", path: f.name, name: f.name },
          ),
        ),
      );
    };
    input.click();
  });
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
  for (const a of atts) if (a.kind === "image") out.push({ type: "image", mime_type: a.mime_type, data: a.data });
  const paths = atts.flatMap((a) => (a.kind === "file" ? [a.path] : a.kind === "folder" ? [/[\\/]$/.test(a.path) ? a.path : a.path + "/"] : []));
  if (paths.length) out.push(attachedBlock(paths));
  const web = atts.flatMap((a) => (a.kind === "web" ? [a.comment] : []));
  if (web.length) out.push(webCommentBlock(web));
  return out;
}
