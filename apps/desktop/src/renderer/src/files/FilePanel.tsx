import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { SidebarToggle } from "../components";
import { PresentationLoading } from "../docs/pptx/PresentationLoading";
import { PdfView, Unlock } from "../docs/PdfView";
import { SheetView } from "../docs/SheetView";
import { useSessionDocs } from "../docs/state";
import { Icon } from "../icons";
import { useStore } from "../store";
import { fileMenu, opensAsPage, otherView, showPage } from "../session/contentMenus";
import { Markdown } from "../session/Markdown";
import { ContentScope } from "../session/scope";
import { usePanelWidth } from "../panelWidth";
import { activate, closeTab, flushAll, recheckActive, setPreview, setTree, takeDisk, takePresentationDisk, takeWordDisk, useFiles, type SessionFiles, type Tab } from "./state";
import { FileCard, FileLoading as Loading } from "./FileCard";
import { ImageView } from "./ImageView";
import { isGrid, isLegacyWord, isMarkdown, isPresentation, isSvg, isWord, previewable } from "./kind";
import { WordLoading } from "../docs/docx/WordLoading";
import { setWordAiHost } from "../docs/docx/ai";
import { isRunning } from "@finx/client";
import { Tree } from "./Tree";
import { sizeText } from "../format";

// The file panel (file-panel-design §3): the session's open files as tabs, with the file's tools
// (how its edits stand, preview or source, its menu, the tree) at the strip's end; the editor or
// the preview with the folder tree on its right, and a note under them when there is a choice to
// make. The browser panel's column and strip. A PDF shows in pdf.js, a workbook in the grid, each with a
// bar of its own tools under the strip (document-editor-design §7.2, spreadsheet-design §8).

const Editor = lazy(() => import("./Editor"));
const PresentationView = lazy(() => import("../docs/pptx/PresentationView"));
const WordView = lazy(() => import("../docs/docx/WordView"));

/** What the conversation keeps beside the panel at least, as with the browser; more beside a document, which is read beside it. */
const conversationRoom = (doc: boolean) => (doc ? 360 : 160);

/** An encoding as people know it. */
const encodingName = (e: string) => (e === "gb18030" ? "GBK" : e.startsWith("utf-16") ? "UTF-16" : e.toUpperCase());


const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))) || path;

export function FilePanel({ session, cwd, max, onMax, onClose }: { session: string; cwd: string; max: boolean; onMax: (max: boolean) => void; onClose: () => void }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const s = useFiles(session, cwd);
  // The Word editor's own root reaches the conversation through this: its in-document AI's turns.
  const sessions = useRef(st.sessions);
  sessions.current = st.sessions;
  useEffect(() => {
    if (!st.rpc) return;
    setWordAiHost({ rpc: st.rpc, op: st.op, live: (id) => { const x = sessions.current.find((y) => y.session_id === id); return !!x && isRunning(x); } });
  }, [st.rpc, st.op]);
  const docs = useSessionDocs(session);
  const tab = s.tabs.find((x) => x.path === s.active) ?? null;
  const { panel, width, resizing, style, grip } = usePanelWidth("finxwork.filePanelWidth", () => conversationRoom(!!tab?.opened || !!tab?.presentation || !!tab?.word));
  const docOf = (x: Tab) => docs.tabs.find((d) => d.info.doc_id === x.opened?.docId);
  // No file open: the panel is only the folder tree to pick one from, not an empty editor's width.
  const bare = s.tabs.length === 0;
  const wide = max && !bare;

  // The last file closed: the panel goes with it, as the browser's does with its last tab.
  const hadTabs = useRef(!bare);
  useEffect(() => {
    if (bare && hadTabs.current) onClose();
    hadTabs.current = !bare;
  }, [bare]);

  // The tree, the first time: beside the code when there is room for both.
  useLayoutEffect(() => {
    if (s.tree === null) setTree(s, (panel.current?.getBoundingClientRect().width ?? 0) >= 600);
  }, [s]);

  // Leaving (another session, the panel closed) or the window going away: edits are saved first.
  useEffect(() => {
    const hidden = () => void flushAll();
    window.addEventListener("blur", hidden);
    window.addEventListener("focus", recheckActive);
    return () => {
      window.removeEventListener("blur", hidden);
      window.removeEventListener("focus", recheckActive);
      void flushAll(s);
    };
  }, [s]);

  return (
    <aside
      ref={panel}
      className={`bgp brp fpn ${bare ? "bare" : wide ? "max" : width !== null ? "sized" : ""} ${resizing ? "resizing" : ""}`}
      style={bare ? undefined : style(wide)}
      aria-label={t("files.title")}
    >
      <div className="brp-strip drag">
        {wide && <SidebarToggle />}
        <div className="brp-tabs" role="tablist">
          {s.tabs.map((x) => {
            const on = x.path === s.active;
            const opened = docOf(x);
            const dirty = !!x.doc?.dirty || !!x.presentation?.dirty || !!x.word?.dirty || !!opened?.info.dirty;
            const locked = x.read?.kind === "text" && !x.read.writable;
            // A workbook (xlsx, xlsm, xls, csv, tsv) shows as a grid; until it opens, its name says so.
            const grid = opened ? opened.info.layout === "grid" : isGrid(x.path);
            return (
              <div key={x.path} role="tab" aria-selected={on} className={`brp-tab fpn-tab no-drag ${on ? "on" : ""} ${dirty ? "dirty" : ""}`} title={x.rel ?? x.path} onClick={() => activate(s, x.path)}>
                <span className="brp-tab-ic">
                  <Icon name={locked ? "lock" : x.opened ? (grid ? "grid" : "doc") : isPresentation(x.path) || isWord(x.path) ? "doc" : "file"} />
                </span>
                <span className="brp-tab-t">{x.name}</span>
                <button
                  className="brp-tab-x"
                  aria-label={t("files.closeTab", { name: x.name })}
                  title={t("files.closeTab", { name: x.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(st, s, x.path);
                  }}
                >
                  <Icon name="x" />
                </button>
              </div>
            );
          })}
        </div>
        {!bare && (
          <>
            <Tools s={s} tab={tab} />
            <span className="fpn-strip-sep" />
            <button className="tb" aria-label={max ? t("browser.restore") : t("browser.maximize")} title={max ? t("browser.restore") : t("browser.maximize")} onClick={() => onMax(!max)}>
              <Icon name={max ? "shrink" : "expand"} />
            </button>
          </>
        )}
        {/* The conversation bar's Files button, moved here while the panel is open: it puts the panel away. */}
        <button className="tb on" aria-label={t("files.hide")} title={t("files.hide")} aria-pressed onClick={onClose}>
          <Icon name="folder" />
        </button>
      </div>
      {/* The file on the left, the tree on the right. */}
      <div className="fpn-body">
        {!bare && <div className="fpn-main">
          {/* PDFs stay laid out while another tab shows: pdf.js would load and lay them out again. */}
          {st.rpc &&
            s.tabs.map((x) => {
              const doc = docOf(x);
              return doc && (
                <div key={doc.info.doc_id} className="dcp-viewer" hidden={x !== tab}>
                  {doc.info.layout === "grid" ? (
                    <SheetView rpc={st.rpc!} session={session} tab={doc} activeView={x === tab} jump={docs.jump?.doc_id === doc.info.doc_id ? docs.jump : null} />
                  ) : (
                    <PdfView rpc={st.rpc!} session={session} tab={doc} jump={docs.jump?.doc_id === doc.info.doc_id ? docs.jump : null} />
                  )}
                </div>
              );
            })}
          {tab && !tab.opened?.docId && <Body s={s} tab={tab} />}
        </div>}
        {(bare || s.tree === true) && <Tree s={s} />}
      </div>
      {tab && <Note s={s} tab={tab} />}
      {!wide && !bare && (
        <div
          className="brp-grip no-drag"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("files.resize")}
          tabIndex={0}
          {...grip}
        />
      )}
    </aside>
  );
}

/** The file's tools at the strip's end: how its edits stand, preview or source, its menu, and the tree's switch. */
function Tools({ s, tab }: { s: SessionFiles; tab: Tab | null }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const read = tab?.read;
  const doc = tab?.doc;
  const presentation = tab?.presentation ?? tab?.word;
  const status = presentation
    ? !presentation.file.writable ? t("files.readOnly")
      : presentation.state === "saving" ? t("files.saving")
      : presentation.dirty ? t("files.unsaved")
      : presentation.savedAt ? t("files.saved") : ""
    : !read || read.kind !== "text"
    ? ""
    : !read.writable
      ? read.encoding && !read.encoding.startsWith("utf-8") ? t("files.readOnlyEncoding", { encoding: encodingName(read.encoding) }) : t("files.readOnly")
      : doc?.state === "dirty" ? t("files.unsaved")
      : doc?.state === "saving" ? t("files.saving")
      : doc?.state === "clean" && doc.savedAt ? t("files.saved")
      : "";
  const canPreview = tab && read?.kind === "text" && previewable(tab.name);
  return (
    <div className="fpn-tools no-drag">
      {status && <span className={`fpn-state ${doc?.state ?? ""}`}>{status}</span>}
      {canPreview && tab && (
        <button
          className={`tb ${tab.preview ? "" : "on"}`}
          aria-label={t("files.source")}
          title={tab.preview ? t("files.source") : t("files.preview")}
          aria-pressed={!tab.preview}
          onClick={() => setPreview(s, tab, !tab.preview)}
        >
          <Icon name="code" />
        </button>
      )}
      {tab && !tab.error && opensAsPage(tab.path) && (
        <button
          className="tb"
          aria-label={t("content.previewInBrowser")}
          title={t("content.previewInBrowser")}
          // What was just typed is saved first, so the page shows it.
          onClick={() => void flushAll(s).then(() => showPage(st, s.session, tab.path))}
        >
          <Icon name="globe" />
        </button>
      )}
      {tab && (
        <button
          className="tb"
          aria-label={t("files.more")}
          title={t("files.more")}
          onClick={() => void fileMenu(st, { path: tab.path, rel: tab.rel, kind: tab.error ? null : "file" }, tab.target?.line, undefined, tab.error ? undefined : otherView(st, s.session, s.cwd, tab.path, "source"))}
        >
          <Icon name="more" />
        </button>
      )}
      <button className={`tb ${s.tree ? "on" : ""}`} aria-label={t("files.toggleTree")} title={t("files.toggleTree")} aria-pressed={!!s.tree} onClick={() => setTree(s, !s.tree)}>
        <Icon name="tree" />
      </button>
    </div>
  );
}

/** The open file: its editor, what it looks like (Markdown, SVG, an image), or why it is not shown. */
function Body({ s, tab }: { s: SessionFiles; tab: Tab }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const read = tab.read;
  if (tab.presentation && st.rpc) return (
    <Suspense fallback={<PresentationLoading name={tab.name} stage="preparing" bytes={tab.presentation.bytes.byteLength} fontCount={tab.presentation.file.font_families.length} />}>
      <PresentationView doc={tab.presentation} rpc={st.rpc} session={s.session} name={tab.name} />
    </Suspense>
  );
  if (tab.word) return (
    <Suspense fallback={<WordLoading name={tab.name} stage="reading" />}>
      <WordView doc={tab.word} name={tab.name} path={tab.path} />
    </Suspense>
  );
  // A .doc: the old binary format is not opened here (word-design §0); the card offers its own app.
  if (isLegacyWord(tab.path)) return <Card tab={tab} text={t("word.legacy")} />;
  if (tab.error && !tab.doc) return <Card tab={tab} text={tab.error} />;
  if (tab.opened) return tab.opened.locked ? <Unlock s={s} tab={tab} /> : <Loading />;
  if (!read && isWord(tab.path)) return <WordLoading name={tab.name} stage="reading" />;
  if (!read) return isPresentation(tab.path)
    ? <PresentationLoading name={tab.name} stage={tab.presentationProgress?.stage ?? "reading"}
        completed={tab.presentationProgress?.completed} total={tab.presentationProgress?.total}
        bytes={tab.presentationProgress?.bytes} />
    : <Loading />;
  if (read.kind === "image" && read.image) {
    return (
      <ImageView key={tab.path} src={`data:${read.image.mime_type};base64,${read.image.data}`} alt={tab.name} />
    );
  }
  if (read.kind === "binary") return <Card tab={tab} text={t("files.binary")} />;
  if (read.kind === "too_large") return <Card tab={tab} text={t("files.tooLarge", { size: sizeText(read.size) })} />;
  const text = tab.doc?.text ?? read.text ?? "";
  if (tab.preview && isSvg(tab.name)) {
    return (
      <ImageView key={tab.path} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`} alt={tab.name} />
    );
  }
  if (tab.preview && isMarkdown(tab.name)) {
    // Its links and paths are the file's own: relative to its folder.
    return (
      <ContentScope value={{ session: s.session, cwd: dirOf(tab.path) }}>
        <div className="fpn-md">
          <Markdown text={text} mode="document" />
        </div>
      </ContentScope>
    );
  }
  const editable = !!read.writable && tab.doc?.state !== "refused";
  return (
    <Suspense fallback={<Loading />}>
      <Editor tab={tab} editable={editable} onSave={(x) => void x.doc?.flush().then(() => x.doc?.state === "failed" && st.show(t("files.failed", { message: x.doc.message ?? "" }), undefined, true))} />
    </Suspense>
  );
}

/** Why a file is not shown, and where else it opens. */
function Card({ tab, text }: { tab: Tab; text: string }) {
  return <FileCard path={tab.path} rel={tab.rel} text={text} gone={!!tab.error} />;
}

/** A choice to make, under the file: it changed elsewhere, it is gone, it would not save. */
function Note({ s, tab }: { s: SessionFiles; tab: Tab }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const doc = tab.doc;
  if (tab.presentation) {
    const pptx = tab.presentation;
    const conflict = pptx.state === "conflict" || pptx.state === "deleted";
    if (!conflict && pptx.state !== "failed" && pptx.state !== "refused" && !tab.error) return null;
    return <div className="fpn-note warn" role="alert">
      <Icon name="warn" />
      <span>{tab.error ?? (conflict ? t("pptx.conflict") : t("files.failed", { message: pptx.message ?? "" }))}</span>
      {conflict && <button className="btn sm" onClick={() => void takePresentationDisk(s, tab)}>{t("files.takeDisk")}</button>}
      {pptx.state === "failed" && <button className="btn sm" onClick={() => void pptx.flush()}>{t("files.retry")}</button>}
    </div>;
  }
  if (tab.word) {
    const word = tab.word;
    if (word.state === "conflict") return <div className="fpn-note warn" role="alert">
      <Icon name="warn" />
      <span>{t("word.conflict")}</span>
      <button className="btn sm" onClick={() => void word.overwrite()}>{t("word.overwrite")}</button>
      <button className="btn sm" onClick={() => void takeWordDisk(s, tab)}>{t("word.reload")}</button>
    </div>;
    if (word.state !== "failed" && word.state !== "refused" && !tab.error) return null;
    return <div className="fpn-note warn" role="alert">
      <Icon name="warn" />
      <span>{tab.error ?? t("files.failed", { message: word.message ?? "" })}</span>
      {word.state === "failed" && <button className="btn sm" onClick={() => void word.flush()}>{t("files.retry")}</button>}
    </div>;
  }
  if (!doc) return null;
  switch (doc.state) {
    case "conflict":
      return (
        <div className="fpn-note warn" role="alert">
          <Icon name="warn" />
          <span>{t("files.conflict")}</span>
          <button className="btn sm" onClick={() => void takeDisk(s, tab)}>{t("files.takeDisk")}</button>
          <button className="btn sm" onClick={() => void doc.keepMine()}>{t("files.keepMine")}</button>
        </div>
      );
    case "deleted":
      return (
        <div className="fpn-note warn" role="alert">
          <Icon name="warn" />
          <span>{t("files.deleted")}</span>
          <button className="btn sm" onClick={() => void closeTab(st, s, tab.path)}>{t("files.closeIt")}</button>
          <button className="btn sm" onClick={() => void doc.keepMine()}>{t("files.saveAgain")}</button>
        </div>
      );
    case "failed":
      return (
        <div className="fpn-note bad" role="alert">
          <Icon name="warn" />
          <span>{t("files.failed", { message: doc.message ?? "" })}</span>
          <button className="btn sm" onClick={() => void doc.flush()}>{t("files.retry")}</button>
        </div>
      );
    case "refused":
      return (
        <div className="fpn-note" role="status">
          <Icon name="lock" />
          <span>{t(/finx/i.test(doc.message ?? "") ? "files.refusedData" : "files.refusedEncoding")}</span>
        </div>
      );
    default:
      return null;
  }
}
