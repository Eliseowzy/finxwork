import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, useTranslation } from "react-i18next";
import { DocxEditor, type DocxEditorRef, type TrackedChangesOptions } from "@betteroffice/docx-react";
import type { CollaborationReplica } from "@betteroffice/docx/collaboration";
import type { BundledFontProvider } from "@betteroffice/docx/layout";
import zhCN from "@betteroffice/docx-i18n/zh-CN";
import "@betteroffice/docx-react/styles.css";
import { i18n } from "../../../../shared/i18n";
import { fromBase64 } from "../pptx/document";
import type { WordDoc } from "./document";
import { wordFontProvider } from "./fonts";
import { registerWordHandle } from "./handle";
import { WordLoading } from "./WordLoading";
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

  if (error && !ready) return <div className="word-message" role="alert">{t("word.loadFailed", { message: error })}</div>;
  const loading = <WordLoading name={name} stage={fonts ? "rendering" : "fonts"} />;
  if (!fonts) return loading;
  return <div className="word-editor-shell">
    {error && <div className="word-error" role="alert">{error}</div>}
    {!doc.file.writable && <ReadOnlyBar doc={doc} name={name} />}
    <div className="word-editor-canvas"><DocxEditor
      ref={editor}
      file={bytes}
      fileName={name}
      measurementFontProvider={fonts.provider}
      collaboration={collaboration}
      readOnly={!doc.file.writable}
      colorMode="system"
      i18n={language.startsWith("zh") ? zhCN : undefined}
      trackedChanges={trackedChanges}
      loadingIndicator={null}
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
