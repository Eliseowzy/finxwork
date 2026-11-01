import type { WebComment } from "@finx/client";

/** Where on the page the person pointed: the element and the spot inside it (0–1). */
export type AnnotationAnchor = { selector: string; text: string; tag: string; x: number; y: number };
export type AnnotationState = { url: string; enabled: boolean; language: string };
/** A part of a page on its way to a conversation's composer. */
export type BrowserComment = { session: string; comment: WebComment };

export const maxComment = 4000;

export function validAnchor(value: unknown): value is AnnotationAnchor {
  if (!value || typeof value !== "object") return false;
  const a = value as AnnotationAnchor;
  return typeof a.selector === "string" && a.selector.length > 0 && a.selector.length <= 4096
    && typeof a.text === "string" && a.text.length <= 240 && typeof a.tag === "string" && a.tag.length > 0 && a.tag.length <= 40
    && Number.isFinite(a.x) && a.x >= 0 && a.x <= 1 && Number.isFinite(a.y) && a.y >= 0 && a.y <= 1;
}

/** What the page's request becomes in the conversation; the URL and title are the tab's own, never the page's word. */
export function webComment(url: string, title: string, request: { anchor?: unknown; body?: unknown }): WebComment {
  if (!validAnchor(request.anchor) || typeof request.body !== "string" || request.body.length > maxComment) throw new Error("Invalid comment");
  const { tag, text, selector } = request.anchor;
  return { url, title: title.slice(0, 300), tag, text, selector, comment: request.body.trim() };
}
