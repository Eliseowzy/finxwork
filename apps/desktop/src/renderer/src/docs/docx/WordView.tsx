import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, useTranslation } from "react-i18next";
import { DocxEditor, type DocxCommandExecution, type DocxEditorRef, type TrackedChangesOptions } from "@nimbleoffice/docx-react";
import type { CollaborationReplica } from "@nimbleoffice/docx/collaboration";
import type { BundledFontProvider } from "@nimbleoffice/docx/layout";
import "@nimbleoffice/docx-react/styles.css";
import { i18n } from "../../../../shared/i18n";
import { fromBase64 } from "../pptx/document";
import { listFonts } from "../pptx/fonts";
import type { WordDoc } from "./document";
import { wordFontProvider } from "./fonts";
import { registerWordHandle } from "./handle";
import { wordZhCN } from "./i18n";
import { WordLoading } from "./WordLoading";
import { createFit, WordToolbar } from "./WordToolbar";
import { ExportPdfDialog } from "./ExportPdf";
import { askFromComment, WordAi } from "./WordAi";
import "../pptx/theme.css";
import "./word.css";

/** The author the agent's revisions carry (word-design §0). */
export const AI_AUTHOR = "FinxWork AI";

/** The agent's revisions show as the agent's: the brand colour and ✦, not a person's initials. */
export const trackedChanges: TrackedChangesOptions = {
  getAuthorAppearance: ({ name }) => name === AI_AUTHOR
    ? { kind: "agent", color: brandColor(), icon: <span className="word-ai-mark" aria-hidden="true">✦</span> }
    : undefined,
};

/** Fitting the page: the room left beside it, and the zooms it keeps within. */
const FIT_GUTTER = 24, FIT_MIN = 0.5, FIT_MAX = 1.25;
/** The zooms a pinch keeps within. */
const PINCH_MIN = 0.25, PINCH_MAX = 4;
/** The comments sidebar's width and gap (@nimbleoffice/docx SIDEBAR_WIDTH + SIDEBAR_PAGE_GAP). */
const SIDEBAR = 352;
/** Below this panel width the outline button's gutter costs the page too much. */
const OUTLINE_MIN = 960;

function brandColor() {
  const value = typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return value || "#2f6fd6";
}

function Editor({ doc, name, path }: { doc: WordDoc; name: string; path: string }) {
  const { t } = useTranslation("session");
  // Faces load as the layout asks for them, so this waits only for the machine's font list.
  const [fonts, setFonts] = useState<{ provider?: BundledFontProvider } | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState(i18n.language);
  const editor = useRef<DocxEditorRef | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const fit = useMemo(createFit, [doc]);
  const [zoom, setZoom] = useState(1);
  const [wide, setWide] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEffect(() => { fit.exportPdf = () => setExporting(true); return () => { fit.exportPdf = () => {}; }; }, [fit]);
  // The font menu: the document's families, then every family installed on the machine (as the PPT
  // editor's), which the font provider draws face by face as they are picked.
  const [fontFamilies, setFontFamilies] = useState<string[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void listFonts().then((installed) => {
      if (!live) return;
      const seen = new Set<string>();
      const names = [...doc.file.font_families, ...installed.map((f) => f.family)].filter((name) => {
        const key = name.toLowerCase();
        if (!name || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setFontFamilies(names);
    }, (e: unknown) => console.warn("font list unavailable", e));
    return () => { live = false; };
  }, [doc]);
  const bytes = useMemo(() => fromBase64(doc.file.data), [doc, doc.generation]);
  const kernel = doc.kernel;
  const where = useMemo(() => ({ session: kernel.session, docxId: kernel.docxId, path }), [kernel, path]);
  // A replica of the kernel's document: it joins with the kernel's state and syncs through it.
  const collaboration = useMemo(() => ({
    clientId: kernel.clientId,
    initialUpdate: kernel.initialState,
    onReplica: (replica: CollaborationReplica | null) => kernel.attach(replica),
  }), [kernel]);

  useLayoutEffect(() => {
    let live = true;
    void wordFontProvider().then((provider) => { if (live) setFonts({ provider }); },
      (e: unknown) => { if (live) setFonts({}); console.warn("word fonts unavailable", e); });
    const locale = (lng: string) => setLanguage(lng);
    i18n.on("languageChanged", locale);
    return () => { live = false; i18n.off("languageChanged", locale); doc.prepare = null; };
  }, [doc, kernel]);

  // Once the first page shows: saves flush held-back typing, and the in-document AI can find this editor.
  useEffect(() => {
    if (!ready || !editor.current) return;
    const ref = editor.current;
    doc.prepare = () => ref.flushPendingInput();
    const release = registerWordHandle({ docxId: kernel.docxId, path, editor: ref });
    return () => { release(); if (doc.prepare) doc.prepare = null; };
  }, [ready, doc, kernel, path]);

  // Fit the page to the panel's width while the person has not chosen a zoom; again as the panel resizes.
  useEffect(() => {
    const box = canvas.current;
    const ref = editor.current;
    if (!ready || !box || !ref) return;
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const page = box.querySelector("canvas");
        const now = ref.getZoom();
        if (!page || !now) return;
        const width = page.getBoundingClientRect().width / now;
        const roomy = box.clientWidth >= OUTLINE_MIN;
        setWide(roomy);
        if (fit.auto && width > 0) {
          // The editor centres the page between two allowances for its outline button, and shifts it for the comments.
          const room = box.clientWidth - 2 * (roomy ? 64 : 20) - FIT_GUTTER;
          const beside = (room - SIDEBAR) / width;
          const next = Math.round(Math.min(FIT_MAX, Math.max(FIT_MIN, fit.sidebar && beside >= FIT_MIN ? beside : room / width)) * 100) / 100;
          fit.set = next;
          if (Math.abs(next - now) > 0.001) ref.setZoom(next);
        }
        setZoom(ref.getZoom());
      });
    };
    fit.refit = refit;
    fit.zoomed = setZoom;
    const seen = new ResizeObserver(refit);
    seen.observe(box);
    refit();
    return () => { seen.disconnect(); cancelAnimationFrame(frame); fit.refit = () => {}; fit.zoomed = () => {}; };
  }, [ready, fit]);

  // Pinch to zoom: the trackpad's pinch arrives as a wheel with ctrl held (as does ctrl+wheel).
  // It is the person's zoom, so fitting stops.
  useEffect(() => {
    const box = canvas.current;
    const ref = editor.current;
    if (!ready || !box || !ref) return;
    let frame = 0, delta = 0;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      delta += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const now = ref.getZoom() || 1;
        const next = Math.round(Math.min(PINCH_MAX, Math.max(PINCH_MIN, now * Math.exp(-delta / 100))) * 100) / 100;
        delta = 0;
        if (Math.abs(next - now) < 0.001) return;
        fit.auto = false;
        fit.set = null;
        ref.setZoom(next);
        setZoom(ref.getZoom());
      });
    };
    box.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => { box.removeEventListener("wheel", wheel, { capture: true }); cancelAnimationFrame(frame); };
  }, [ready, fit]);

  // The pen takes the colour last picked from the toolbar's highlight menu.
  const onCommandExecuted = useCallback(({ id, args }: DocxCommandExecution) => {
    const color = id === "highlightColor" ? (args as { color?: unknown } | null)?.color : undefined;
    if (typeof color === "string" && color !== "none" && color !== fit.penColor) {
      fit.penColor = color;
      fit.listeners.forEach((l) => l());
    }
  }, [fit]);

  // The highlighter pen: while on, each stretch of text the mouse selects is highlighted, as Word's pen does. Esc stops it.
  useEffect(() => {
    const box = canvas.current;
    const ref = editor.current;
    if (!ready || !box || !ref) return;
    const sync = () => box.classList.toggle("word-pen", fit.pen);
    fit.listeners.add(sync);
    sync();
    const up = (e: PointerEvent) => {
      if (!fit.pen || e.button !== 0 || !(e.target as HTMLElement).closest?.("canvas")) return;
      // After the editor settles the selection the drag made.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        // A click without a drag selects nothing: leave it, so typing after it is not highlighted.
        void ref.readSelectionInfo().then((info) => {
          const state = ref.commands.getState("highlightColor");
          if (!info?.selectedText || !state.enabled) return;
          // As Word's pen: over text already in the pen's colour, it takes the highlight off.
          const color = fit.penColor;
          void ref.commands.execute("highlightColor", { color: state.value === color ? "none" : color });
        }, () => {});
      }));
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && fit.pen) { fit.pen = false; fit.listeners.forEach((l) => l()); }
    };
    box.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => { fit.listeners.delete(sync); box.removeEventListener("pointerup", up); window.removeEventListener("keydown", key); box.classList.remove("word-pen"); };
  }, [ready, fit]);

  if (error && !ready) return <div className="word-message" role="alert">{t("word.loadFailed", { message: error })}</div>;
  const loading = <WordLoading name={name} stage={fonts ? "rendering" : "fonts"} />;
  if (!fonts) return loading;
  return <div className="word-editor-shell">
    {error && <div className="word-error" role="alert">{error}</div>}
    {!doc.file.writable && <ReadOnlyBar doc={doc} name={name} />}
    <div className="word-editor-canvas" ref={canvas} data-zoom={zoom}><DocxEditor
      ref={editor}
      file={bytes}
      fileName={name}
      measurementFontProvider={fonts.provider}
      fontFamilies={fontFamilies}
      commentSidebarOverflow="inset"
      onCommandExecuted={onCommandExecuted}
      collaboration={collaboration}
      readOnly={!doc.file.writable}
      colorMode="system"
      i18n={language.startsWith("zh") ? wordZhCN : undefined}
      trackedChanges={trackedChanges}
      loadingIndicator={null}
      toolbar={<WordToolbar fit={fit} />}
      showOutlineButton={wide}
      author={window.finx?.userName || undefined}
      showFileOpen={false}
      showHelpMenu={false}
      style={{ height: "100%", width: "100%", minHeight: 0 }}
      onFirstPagePainted={() => setReady(true)}
      onCommentAdd={(comment) => {
        // A comment opening with @AI asks the agent (word-design §5.1 item 4).
        if (editor.current) void askFromComment(editor.current, where, comment, t).catch((e: unknown) => console.warn("word AI comment", e));
      }}
      onDocumentChange={() => {
        // A change the kernel sent (the agent's) is not an edit of this editor's to save.
        if (kernel.local()) doc.edit();
      }}
      onSaveRequest={async () => { await doc.flush(); return false; }}
      downloadOnSave={false}
      onError={(e) => setError(e.message)}
    />{ready && editor.current && <WordAi editor={editor.current} where={where} readOnly={!doc.file.writable} />}</div>
    {!ready && !error && <div className="word-opening-overlay">{loading}</div>}
    {exporting && <ExportPdfDialog doc={doc} path={path} onClose={() => setExporting(false)} />}
  </div>;
}

/** A read-only file: it can be saved as a copy elsewhere, nothing more. */
function ReadOnlyBar({ doc, name }: { doc: WordDoc; name: string }) {
  const { t } = useTranslation("session");
  const [note, setNote] = useState<string | null>(null);
  const saveAs = async () => {
    const path = window.finx ? await window.finx.pickSaveFile(name) : window.prompt(t("word.saveAs"), name);
    if (!path) return;
    try {
      const r = await doc.saveAs(path);
      setNote(r.status === "saved" ? t("word.savedAs", { path }) : t("files.failed", { message: r.message ?? r.status }));
    } catch (e) { setNote(t("files.failed", { message: e instanceof Error ? e.message : String(e) })); }
  };
  return <div className="word-readonly" role="status">
    <span>{note ?? t("word.readOnly")}</span>
    <button type="button" className="btn sm" onClick={() => void saveAs()}>{t("word.saveAs")}</button>
  </div>;
}

/** Attach the persistent editor surface. Switching tabs/panels keeps its worker and undo history. */
export default function WordView({ doc, name, path }: { doc: WordDoc; name: string; path: string }) {
  const container = useRef<HTMLDivElement>(null);
  const { t } = useTranslation("session");
  useLayoutEffect(() => {
    if (!doc.surface) {
      const element = document.createElement("div");
      element.className = "word-surface";
      const root = createRoot(element);
      doc.surface = { element, dispose: () => { element.remove(); queueMicrotask(() => root.unmount()); } };
      // A separate root does not inherit the app's provider; without it every string renders as its key.
      root.render(<I18nextProvider i18n={i18n}><Editor doc={doc} name={name} path={path} /></I18nextProvider>);
    }
    const element = doc.surface.element;
    container.current?.append(element);
    return () => { element.remove(); };
  }, [doc, doc.generation, name, path]);
  return <div className="word-view" ref={container} aria-label={t("word.editor")} />;
}
