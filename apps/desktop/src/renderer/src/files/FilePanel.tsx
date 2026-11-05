import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { SidebarToggle } from "../components";
import { PdfView, Unlock } from "../docs/PdfView";
import { SheetView } from "../docs/SheetView";
import { useSessionDocs } from "../docs/state";
import { Icon } from "../icons";
import { useStore } from "../store";
import { fileMenu, openRef } from "../session/contentMenus";
import { Markdown } from "../session/Markdown";
import { ContentScope } from "../session/scope";
import { usePanelWidth } from "../panelWidth";
import { activate, closeTab, flushAll, recheckActive, setPreview, setTree, takeDisk, useFiles, type SessionFiles, type Tab } from "./state";
import { ImageView } from "./ImageView";
import { isGrid, isMarkdown, isSvg, previewable } from "./kind";
import { Tree } from "./Tree";
import { sizeText } from "../format";

// The file panel (file-panel-design §3): the session's open files as tabs, with the file's tools
// (how its edits stand, preview or source, its menu, the tree) at the strip's end; the editor or
// the preview with the folder tree on its right, and a note under them when there is a choice to
// make. The browser panel's column and strip. A PDF shows in pdf.js, a workbook in the grid, each with a
// bar of its own tools under the strip (document-editor-design §7.2, spreadsheet-design §8).

const Editor = lazy(() => import("./Editor"));

/** What the conversation keeps beside the panel at least, as with the browser; more beside a document, which is read beside it. */
const conversationRoom = (doc: boolean) => (doc ? 360 : 160);

/** An encoding as people know it. */
const encodingName = (e: string) => (e === "gb18030" ? "GBK" : e.startsWith("utf-16") ? "UTF-16" : e.toUpperCase());


const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))) || path;

export function FilePanel({ session, cwd, max, onMax, onClose }: { session: string; cwd: string; max: boolean; onMax: (max: boolean) => void; onClose: () => void }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const s = useFiles(session, cwd);
  const docs = useSessionDocs(session);
  const tab = s.tabs.find((x) => x.path === s.active) ?? null;
  const { panel, width, resizing, style, grip } = usePanelWidth("finxwork.filePanelWidth", () => conversationRoom(!!tab?.opened));
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
            const dirty = !!x.doc?.dirty || !!opened?.info.dirty;
            const locked = x.read?.kind === "text" && !x.read.writable;
            // A workbook (xlsx, xlsm, xls, csv, tsv) shows as a grid; until it opens, its name says so.
            const grid = opened ? opened.info.layout === "grid" : isGrid(x.path);
            return (
              <div key={x.path} role="tab" aria-selected={on} className={`brp-tab fpn-tab no-drag ${on ? "on" : ""} ${dirty ? "dirty" : ""}`} title={x.rel ?? x.path} onClick={() => activate(s, x.path)}>
                <span className="brp-tab-ic">
                  <Icon name={locked ? "lock" : x.opened ? (grid ? "grid" : "doc") : "file"} />
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
  const status = !read || read.kind !== "text"
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
      {tab && (
        <button
          className="tb"
          aria-label={t("files.more")}
          title={t("files.more")}
          onClick={() => void fileMenu(st, { path: tab.path, rel: tab.rel, kind: tab.error ? null : "file" }, tab.target?.line)}
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
  if (tab.error && !tab.doc) return <Card tab={tab} text={tab.error} />;
  if (tab.opened) return tab.opened.locked ? <Unlock s={s} tab={tab} /> : <Loading />;
  if (!read) return <Loading />;
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

function Loading() {
  const { t } = useTranslation("session");
  return (
    <div className="fpn-empty">
      <span className="mini-spin" aria-label={t("files.loading")} />
    </div>
  );
}

/** Why a file is not shown, and where else it opens. */
function Card({ tab, text }: { tab: Tab; text: string }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const mac = window.finx?.platform === "mac";
  const info = { path: tab.path, rel: tab.rel, kind: tab.error ? null : ("file" as const) };
  return (
    <div className="fpn-card">
      <Icon name="file" />
      <b>{tab.name}</b>
      {/* The name is above; an error that starts with the path need not say it again. */}
      <p>{text.startsWith(`${tab.path}: `) ? text.slice(tab.path.length + 2) : text}</p>
      {!tab.error && (
        <div className="fpn-card-b">
          <button className="btn" onClick={() => void openRef(st, info, undefined, "system")}>{t("files.openDefault")}</button>
          <button className="btn" onClick={() => window.finx?.revealPath(tab.path)}>{t(mac ? "content.revealFinder" : "content.reveal")}</button>
        </div>
      )}
    </div>
  );
}

/** A choice to make, under the file: it changed elsewhere, it is gone, it would not save. */
function Note({ s, tab }: { s: SessionFiles; tab: Tab }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const doc = tab.doc;
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
