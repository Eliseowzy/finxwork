import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PptxEditor, definePptxPlugin, type PptxAsyncEditorApi } from "@betteroffice/pptx-react";
import type { AsyncCollaborationReplica, PptxFontFace } from "@betteroffice/pptx";
import { presentationZhCN } from "./zh-CN";
import { I18nextProvider, useTranslation } from "react-i18next";
import type { RpcClient } from "@finx/client";
import { i18n } from "../../../../shared/i18n";
import { type PresentationDoc } from "./document";
import { isCjk, listFonts, loadFonts } from "./fonts";
import type { FontEntry } from "./fontMenu";
import { presentationImageDecoder } from "./metafile";
import { PresentationLoading, type FontLoadProgress } from "./PresentationLoading";
import { SlideOutline } from "./SlideOutline";
import { installSlideReorder } from "./slideReorder";
import { installSlideKeys } from "./slideKeys";
import { installCommandKeys } from "./commandKeys";
import { COMMANDS } from "./commands/registry";
import { onSlideRequest, takeSlide } from "./deckEdit";
import { Ribbon, type RibbonFonts } from "./Ribbon";
import { RibbonController } from "./commands/controller";
import { ControllerContext } from "./ribbon/controls";
import "./theme.css";
import "./ribbon.css";
import "./presentation.css";

function Editor({ doc, rpc, session, name }: { doc: PresentationDoc; rpc: RpcClient; session: string; name: string }) {
  const [fontProgress, setFontProgress] = useState<FontLoadProgress>({ completed: 0, total: 0 });
  const [isReady, setReady] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [fonts, setFonts] = useState<PptxFontFace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState(i18n.language);
  const [mediaWarning, setMediaWarning] = useState<string | null>(null);
  const decodeImage = useMemo(() => presentationImageDecoder(rpc, session, setMediaWarning), [rpc, session]);
  const api = useRef<PptxAsyncEditorApi | null>(null);
  // The ribbon's command layer: it reads selection and geometry through a plugin, and edits through the api.
  const controller = useMemo(() => new RibbonController(doc.bytes, !doc.file.writable), [doc]);
  const plugins = useMemo(() => [definePptxPlugin<null>({
    id: "finx-ribbon",
    createState: () => null,
    initialize: (context) => controller.pluginContext(context as never),
    onEvent: (context, event) => controller.pluginEvent(context as never, event),
    overlay: () => <div ref={(element) => controller.setOverlay(element)} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />,
  })], [controller]);
  useEffect(() => () => controller.dispose(), [controller]);
  // Esc puts down a format painter kept by double click.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && controller.current.painter) controller.host.setPainter(null); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [controller]);
  // Families the editor can already draw: the deck's, given at open, plus any picked since.
  const registered = useRef(new Set(doc.file.font_families.map((f) => f.toLowerCase())));
  const ribbonFonts = useMemo<RibbonFonts>(() => ({
    documentFamilies: doc.file.font_families,
    installed: () => listFonts(),
    async use(entry: FontEntry) {
      const key = entry.family.toLowerCase();
      if (registered.current.has(key)) return;
      if (!api.current) throw new Error("editor not ready");
      const faces = await loadFonts([entry.family], () => {}, entry.cjk ? new Set([entry.family]) : undefined);
      if (faces.length === 0) throw new Error(entry.family);
      const access = await api.current.handleAsync();
      for (const face of faces) await access.registerFont(face);
      registered.current.add(key);
    },
  }), [doc, rpc, session]);
  // Chinese text in a Latin font draws in the deck's CJK faces rather than a substitute.
  const fallbackFonts = useMemo(() => fonts?.filter((face) => isCjk(face.family)), [fonts]);
  // A replica of the kernel's deck: it joins with the kernel's state and syncs through it.
  const collaboration = useMemo(() => doc.kernel ? {
    clientId: doc.kernel.clientId,
    initialUpdate: doc.kernel.initialState,
    onReplica: (replica: AsyncCollaborationReplica | null) => doc.kernel?.attach(replica),
  } : undefined, [doc, doc.kernel]);
  const shell = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!shell.current) return;
    return installSlideReorder(shell.current, {
      move: async (id, index) => {
        if (!api.current || !doc.file.writable) return;
        const access = await api.current.handleAsync();
        const snapshot = await access.snapshot();
        if (!snapshot.slides.some((slide) => slide.id === id)) return;
        await access.moveSlide(id, index);
      },
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  }, [doc, fonts]);
  useLayoutEffect(() => {
    if (!shell.current) return;
    return installSlideKeys(shell.current, {
      position: () => ({ index: controller.current.slideIndex, count: controller.current.slides.length }),
      objectSelected: () => { const kind = controller.current.selection?.target.kind; return kind === "shape" || kind === "text"; },
      go: async (index) => { await api.current?.goToSlide(index + 1); },
    });
  }, [controller, fonts]);
  useLayoutEffect(() => {
    if (!shell.current) return;
    return installCommandKeys(shell.current, {
      commands: () => COMMANDS,
      editingText: () => controller.current.selection?.target.kind === "text",
      enabled: (id) => controller.status(id).enabled,
      run: (id) => { void controller.run(id); },
      save: () => { void doc.flush(); },
      selectAllText: () => {
        const { selection, slides, slideIndex } = controller.current;
        if (selection?.target.kind !== "text") return;
        const { shapeId, storyId } = selection.target;
        const story = slides[slideIndex]?.shapes.find((shape) => shape.id === shapeId)?.textStories.find((s) => s.id === storyId);
        // The story ends in a paragraph mark, which is not selectable text.
        if (story) api.current?.selectText({ slide: slideIndex + 1, shapeId, storyId, start: 0, end: Math.max(0, story.length - 1) });
      },
    });
  }, [controller, doc, fonts]);
  useLayoutEffect(() => {
    let live = true;
    void loadFonts(doc.file.font_families, (value) => { if (live) setFontProgress(value); }).then((faces) => { if (live) setFonts(faces); }, (e: unknown) => {
      if (live) setError(e instanceof Error ? e.message : String(e));
    });
    const locale = (lng: string) => setLanguage(lng);
    i18n.on("languageChanged", locale);
    return () => { live = false; i18n.off("languageChanged", locale); api.current = null; doc.serialize = null; doc.prepare = null; };
  }, [doc, rpc, session]);
  const ready = (editor: PptxAsyncEditorApi) => {
    api.current = editor;
    const detach = controller.attach(editor);
    setReady(true);
    doc.serialize = () => editor.save();
    doc.prepare = () => editor.flushPendingInput();
    // A page the conversation asked for: the agent's change it is showing (presentation-deck-edit §6).
    const go = (index: number) => void editor.goToSlide(index + 1);
    const deckId = doc.kernel?.deckId;
    const asked = deckId ? takeSlide(deckId) : null;
    if (asked !== null) go(asked);
    const stopAsking = deckId ? onSlideRequest(deckId, go) : () => {};
    return () => { detach(); stopAsking(); if (api.current === editor) { api.current = null; doc.serialize = null; doc.prepare = null; } };
  };
  if (error && !api.current) return <div className="pptx-message" role="alert">{i18n.t("pptx.loadFailed", { ns: "session", message: error })}</div>;
  const loading = <PresentationLoading name={name} stage={fonts ? "rendering" : "fonts"}
    completed={fontProgress.completed} total={fontProgress.total} font={fontProgress}
    bytes={doc.bytes.byteLength} fontCount={doc.file.font_families.length} />;
  if (!fonts) return loading;
  return <div className="pptx-editor-shell" ref={shell}>{(error || mediaWarning) && <div className="pptx-error" role="alert">{error ?? i18n.t("pptx.mediaWarning", { ns: "session", message: mediaWarning ?? "" })}</div>}<div className="pptx-outline-bar"><button type="button" disabled={!isReady} aria-expanded={outlineOpen} onClick={() => setOutlineOpen(value => !value)}>{i18n.t("pptx.outlineTitle", { ns: "session" })}</button></div><div className="pptx-editor-body">{outlineOpen && api.current && <SlideOutline api={api.current} revision={revision} />}<div className="pptx-editor-canvas"><PptxEditor
    loadingIndicator={null}
    file={doc.bytes}
    fileName={name}
    fonts={fonts}
    fallbackFonts={fallbackFonts}
    defaultFonts={false}
    decodeImage={decodeImage}
    readOnly={!doc.file.writable}
    toolbar={<ControllerContext.Provider value={controller}><Ribbon fonts={ribbonFonts} /></ControllerContext.Provider>}
    plugins={plugins}
    // Agent edits go through deck_edit and its approval card; the engine's proposal review is not wired yet (presentation-deck-edit §4).
    proposals={false}
    i18n={language.startsWith("zh") ? presentationZhCN : undefined}
    style={{ height: "100%", width: "100%", minHeight: 0 }}
    onReady={ready}
    collaboration={collaboration}
    onDocumentChange={() => {
      if (!api.current) return;
      // A change the kernel sent (an accepted proposal) is not an edit of this editor's to save.
      if (!doc.kernel || doc.kernel.local()) doc.edit();
      setRevision(value => value + 1);
    }}
    onSaveRequest={async () => { await doc.flush(); return false; }}
    downloadOnSave={false}
    onError={(e) => setError(e.message)}
  /></div></div>{!isReady && !error && <div className="pptx-opening-overlay">{loading}</div>}</div>;
}

/** Attach the persistent editor surface. Switching tabs/panels keeps its worker and undo history. */
export default function PresentationView({ doc, rpc, session, name }: { doc: PresentationDoc; rpc: RpcClient; session: string; name: string }) {
  const container = useRef<HTMLDivElement>(null);
  const { t } = useTranslation("session");
  useLayoutEffect(() => {
    if (!doc.surface) {
      const element = document.createElement("div");
      element.className = "pptx-surface";
      const root = createRoot(element);
      doc.surface = { element, dispose: () => { element.remove(); queueMicrotask(() => root.unmount()); } };
      // A separate root does not inherit the app's provider; without it every string renders as its key.
      root.render(<I18nextProvider i18n={i18n}><Editor doc={doc} rpc={rpc} session={session} name={name} /></I18nextProvider>);
    }
    const element = doc.surface.element;
    container.current?.append(element);
    return () => { element.remove(); };
  }, [doc, doc.generation, rpc, session, name]);
  return <div className="pptx-view" ref={container} aria-label={t("pptx.editor")} />;
}
