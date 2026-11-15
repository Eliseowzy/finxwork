import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { DocxEditorRef } from "@nimbleoffice/docx-react";
import { quoteToComposer } from "../state";
import { dismissWordRequest, onWordRequests, reviewWordRequest, sendWordRequest, stopWordRequest, wordRequestOf, type WordAiRequest } from "./ai";
import { aiQuestion, commentText, selectedParagraphs, wordCommentInput, wordQuote, wordRequestInput, WORD_ACTIONS, type WordAction, type WordParagraph } from "./aiPrompt";

// The in-document AI in the editor (word-design §5.1): ✦ beside a selection and its menu, ⌘J's
// instruction box, the shimmer and "AI is working… Stop" while a request runs, then "Accept all ·
// Reject all" for that request's revisions. All of it is an overlay; none of it is the document.

type Where = { session: string; docxId: string; path: string };

/** A place on screen that moves with the document: client coordinates when taken, and the scroller then. */
type Anchor = { x: number; top: number; bottom: number; left: number; right: number; scroller: Element | null; scrollTop: number };

const MENU: WordAction[] = WORD_ACTIONS.filter((a) => a !== "custom");

function scrollerAt(x: number, y: number): Element | null {
  for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

/** An anchor for a selection made between two points: the lines it spans, across the page when it spans more than one. */
function anchorOf(from: { x: number; y: number }, to: { x: number; y: number }): Anchor {
  const top = Math.min(from.y, to.y) - 12;
  const bottom = Math.max(from.y, to.y) + 12;
  const page = document.elementFromPoint(to.x, to.y)?.closest("canvas")?.getBoundingClientRect();
  const multi = bottom - top > 36;
  const left = multi && page ? page.left + 8 : Math.min(from.x, to.x) - 6;
  const right = multi && page ? page.right - 8 : Math.max(from.x, to.x) + 6;
  const scroller = scrollerAt(to.x, to.y);
  return { x: to.x, top, bottom, left, right, scroller, scrollTop: scroller?.scrollTop ?? 0 };
}

const labels = (t: TFunction<"session">) => ({
  request: (file: string, what: string) => t("wordAi.message", { file, what }),
  action: (a: WordAction) => t(`wordAi.action.${a}`),
});

/** The paragraphs under the selection now (the caret's one when nothing is selected), and the selected text. */
async function readSelection(editor: DocxEditorRef): Promise<{ text: string; paragraphs: WordParagraph[] } | null> {
  const info = await editor.readSelectionInfo();
  if (!info?.paraId) return null;
  const read = await editor.readParagraphs({ view: "accepted" });
  const all = read.ok ? read.paragraphs.map((p) => ({ id: p.paraId, text: p.text })) : [{ id: info.paraId, text: info.paragraphText }];
  const paragraphs = selectedParagraphs(all, info.paraId, info.selectedText);
  return { text: info.selectedText, paragraphs: paragraphs.length ? paragraphs : [{ id: info.paraId, text: info.paragraphText }] };
}

/** A comment the person added that starts with `@AI`: asked as a turn of the conversation. */
export async function askFromComment(editor: DocxEditorRef, where: Where, comment: { id: number; content: unknown; anchorRange?: { startBlockId?: string | number } }, t: TFunction<"session">) {
  const question = aiQuestion(commentText(comment.content));
  if (!question) return;
  const start = comment.anchorRange?.startBlockId;
  const selection = await readSelection(editor).catch(() => null);
  let paragraphs = selection?.paragraphs ?? [];
  if (typeof start === "string" && !paragraphs.some((p) => p.id === start)) {
    const read = await editor.readParagraphs({ view: "accepted", paraIds: [start] });
    if (read.ok) paragraphs = read.paragraphs.map((p) => ({ id: p.paraId, text: p.text }));
  }
  const input = wordCommentInput({ path: where.path, docxId: where.docxId, commentId: comment.id, question, paragraphs }, { comment: (file, q) => t("wordAi.commentMessage", { file, question: q }) });
  await sendWordRequest(where.session, where.docxId, where.path, paragraphs.map((p) => p.id), input);
}

export function WordAi({ editor, where, readOnly }: { editor: DocxEditorRef; where: Where; readOnly: boolean }) {
  const { t } = useTranslation("session");
  const layer = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [selection, setSelection] = useState<Anchor | null>(null);
  const [open, setOpen] = useState<null | "menu" | "prompt">(null);
  const [text, setText] = useState("");
  const [anchors, setAnchors] = useState<Map<number, Anchor>>(new Map());
  const [, moved] = useState(0);
  const request = useSyncExternalStore(onWordRequests, () => wordRequestOf(where.docxId));
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuAt, setMenuAt] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = useRef<number | null>(null);

  // Where the pointer pressed and let go in the pages: the selection's ends, as near as can be told.
  useEffect(() => {
    const canvas = layer.current?.parentElement;
    if (!canvas) return;
    const down = (e: PointerEvent) => {
      if (layer.current?.contains(e.target as Node)) return;
      press.current = { x: e.clientX, y: e.clientY };
      setOpen(null);
    };
    const up = (e: PointerEvent) => { if (!layer.current?.contains(e.target as Node)) last.current = { x: e.clientX, y: e.clientY }; };
    const scroll = () => moved((n) => n + 1);
    canvas.addEventListener("pointerdown", down, true);
    canvas.addEventListener("pointerup", up, true);
    canvas.addEventListener("scroll", scroll, true);
    return () => {
      canvas.removeEventListener("pointerdown", down, true);
      canvas.removeEventListener("pointerup", up, true);
      canvas.removeEventListener("scroll", scroll, true);
    };
  }, []);

  // ✦ comes with a selection and goes with it.
  useEffect(() => editor.onSelectionChange((s) => {
    if (!s?.hasSelection) { setSelection(null); return; }
    // The pointer's letting go comes after the selection changes: wait for it.
    requestAnimationFrame(() => {
      const to = last.current ?? press.current;
      if (!to) return;
      setSelection(anchorOf(press.current ?? to, to));
    });
  }), [editor]);

  // ⌘J: the instruction box at the caret or selection.
  useEffect(() => {
    const canvas = layer.current?.parentElement?.parentElement;
    if (!canvas || readOnly) return;
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "j") return;
      e.preventDefault();
      e.stopPropagation();
      const at = last.current ?? press.current;
      if (!selection && at) setSelection(anchorOf(press.current ?? at, at));
      setText("");
      setOpen("prompt");
    };
    canvas.addEventListener("keydown", key, true);
    return () => canvas.removeEventListener("keydown", key, true);
  }, [readOnly, selection]);

  useLayoutEffect(() => {
    if (open === "prompt") inputRef.current?.focus();
    if (open === "menu") menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);

  // The result: go to the first change, once.
  useEffect(() => {
    if (!request || request.phase !== "done" || shown.current === request.id) return;
    shown.current = request.id;
    if (!request.revisions.length) { dismissWordRequest(request.docxId, request.id); return; }
    const first = Number(request.revisions[0]);
    void (Number.isFinite(first) ? editor.scrollToChange(first) : Promise.resolve(false)).then((ok) => {
      const p = request.paragraphs[0] ?? request.paragraphs0[0];
      if (!ok && p) void editor.scrollToParagraph(p);
    });
  }, [request, editor]);
  useEffect(() => {
    if (request?.phase === "stopped") dismissWordRequest(request.docxId, request.id);
  }, [request]);

  const run = async (action: WordAction, input?: string) => {
    setOpen(null);
    const at = selection;
    const read = await readSelection(editor).catch(() => null);
    if (!read) return;
    const msg = wordRequestInput({ path: where.path, docxId: where.docxId, action, input, selection: read.text, paragraphs: read.paragraphs }, labels(t));
    const before = wordRequestOf(where.docxId)?.id ?? 0;
    const sent = sendWordRequest(where.session, where.docxId, where.path, read.paragraphs.map((p) => p.id), msg);
    const now = wordRequestOf(where.docxId);
    if (at && now && now.id !== before) setAnchors((m) => new Map(m).set(now.id, at));
    setSelection(null);
    await sent;
  };

  const quote = async () => {
    setOpen(null);
    const read = await readSelection(editor).catch(() => null);
    const q = read && wordQuote(where.path, where.docxId, read.paragraphs, read.text);
    if (q) quoteToComposer(where.session, { quote: q });
  };

  const box = layer.current?.getBoundingClientRect();
  const place = (a: Anchor) => {
    const dy = a.scroller ? a.scroller.scrollTop - a.scrollTop : 0;
    const ox = box?.left ?? 0;
    const oy = box?.top ?? 0;
    const h = box?.height ?? 0;
    const clamp = (y: number) => Math.min(Math.max(y, 4), Math.max(4, h - 36));
    return { top: a.top - dy - oy, bottom: a.bottom - dy - oy, left: a.left - ox, right: a.right - ox, x: a.x - ox, clamp };
  };

  const menuKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("button,input") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); setOpen(null); editor.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
  };

  // The menu beside ✦, flipped to the left or upwards when it would leave the view.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (open !== "menu" || !menu || !selection || !layer.current) { setMenuAt(null); return; }
    const view = layer.current.getBoundingClientRect();
    const p = place(selection);
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const right = p.x + 6;
    const left = right + w + 8 > view.width ? Math.max(4, p.x - w - 6) : right;
    const below = p.top - 2;
    const top = below + h + 8 > view.height ? Math.max(4, Math.min(p.bottom - h, view.height - h - 8)) : Math.max(4, below);
    setMenuAt({ top, left });
  }, [open, selection]);

  const live = request && (request.phase === "sending" || request.phase === "running");
  const reqAnchor = request && anchors.get(request.id);
  const sel = selection && place(selection);

  return (
    <div className="word-ai-layer" ref={layer}>
      {live && reqAnchor && (() => {
        const p = place(reqAnchor);
        return <div className="word-ai-shimmer" style={{ top: p.top, left: p.left, width: Math.max(24, p.right - p.left), height: p.bottom - p.top }} aria-hidden="true" />;
      })()}
      {request && (live || request.phase === "failed" || (request.phase === "done" && request.revisions.length > 0)) && (
        // At the foot of the view, over no line it is about: the shimmer marks the text.
        <RequestBar request={request} style={{ bottom: 16, left: "50%", transform: "translateX(-50%)" }} />
      )}
      {sel && !readOnly && !live && open !== "prompt" && (
        <button
          type="button"
          className="word-ai-spark"
          style={{ top: sel.clamp(sel.top - 26), left: Math.min(Math.max(4, sel.x + 6), (box?.width ?? 0) - 32) }}
          aria-label={t("wordAi.open")}
          title={t("wordAi.open")}
          aria-haspopup="menu"
          aria-expanded={open === "menu"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen(open === "menu" ? null : "menu")}
        >✦</button>
      )}
      {sel && open === "menu" && (
        <div className="word-ai-menu" role="menu" ref={menuRef} onKeyDown={menuKeys} style={menuAt ?? { top: sel.clamp(sel.top - 2), left: Math.max(4, sel.x + 6), visibility: "hidden" }}>
          {MENU.map((a) => (
            <button key={a} type="button" role="menuitem" onClick={() => void run(a)}>{t(`wordAi.action.${a}`)}</button>
          ))}
          <div className="word-ai-sep" role="separator" />
          <button type="button" role="menuitem" onClick={() => { setText(""); setOpen("prompt"); }}>{t("wordAi.action.custom")}</button>
          <button type="button" role="menuitem" onClick={() => void quote()}>{t("wordAi.quote")}</button>
        </div>
      )}
      {open === "prompt" && (
        <form
          className="word-ai-prompt"
          style={sel ? { top: sel.clamp(sel.bottom + 4), left: Math.max(4, Math.min(sel.left, (box?.width ?? 400) - 340)) } : { top: 12, left: 12 }}
          onSubmit={(e) => { e.preventDefault(); if (text.trim()) void run("custom", text); }}
        >
          <span className="word-ai-mark" aria-hidden="true">✦</span>
          <input
            ref={inputRef}
            value={text}
            placeholder={t("wordAi.placeholder")}
            aria-label={t("wordAi.placeholder")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setOpen(null); editor.focus(); } }}
          />
        </form>
      )}
    </div>
  );
}

/** "AI is working… Stop", a failure's reason, or "Accept all · Reject all" for the request's revisions. */
function RequestBar({ request, style }: { request: WordAiRequest; style: React.CSSProperties }) {
  const { t } = useTranslation("session");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = (action: "accept" | "reject") => {
    setBusy(true);
    setError(null);
    reviewWordRequest(request, action).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  const close = <button type="button" className="word-ai-x" aria-label={t("wordAi.close")} onClick={() => dismissWordRequest(request.docxId, request.id)}>×</button>;
  if (request.phase === "sending" || request.phase === "running") {
    return <div className="word-ai-bar" role="status" style={style}>
      <span className="word-ai-mark" aria-hidden="true">✦</span>
      <span>{t("wordAi.working")}</span>
      <button type="button" onClick={() => stopWordRequest(request)}>{t("wordAi.stop")}</button>
    </div>;
  }
  if (request.phase === "failed") {
    return <div className="word-ai-bar bad" role="alert" style={style}>
      <span>{t("wordAi.failed", { message: request.error ?? t("wordAi.unknown") })}</span>
      {close}
    </div>;
  }
  return <div className="word-ai-bar" role="group" aria-label={t("wordAi.result", { count: request.revisions.length })} style={style}>
    <span className="word-ai-mark" aria-hidden="true">✦</span>
    <button type="button" disabled={busy} onClick={() => review("accept")}>{t("wordAi.acceptAll")}</button>
    <span aria-hidden="true">·</span>
    <button type="button" disabled={busy} onClick={() => review("reject")}>{t("wordAi.rejectAll")}</button>
    {error && <span className="word-ai-err">{error}</span>}
    {close}
  </div>;
}
