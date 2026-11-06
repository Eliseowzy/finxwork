import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { baseName } from "@finx/client";
import type { FilesReadResult } from "@finx/protocol";
import { Dialog } from "../components";
import { closeDoc, docsOf, openDoc, useDocOpener, useSessionDocs } from "../docs/state";
import { PdfView } from "../docs/PdfView";
import { SheetView } from "../docs/SheetView";
import { FileCard, FileLoading } from "../files/FileCard";
import { ImageView } from "../files/ImageView";
import { isMarkdown, isSvg, opensAsDoc, previewable, showsInApp, wraps } from "../files/kind";
import { filesOf, parentOf, relativeTo, showFile } from "../files/state";
import { sizeText } from "../format";
import { Icon } from "../icons";
import { CodeBlock } from "../session/content";
import { fileMenu, openLink, opensAsPage, selectionMenu, showPage } from "../session/contentMenus";
import { Markdown } from "../session/Markdown";
import { ContentScope, LocalImages, type Scope } from "../session/scope";
import { errorText, useStore } from "../store";
import { FilePreviewContext, type FilePreviewOpener } from "./context";

// A file to read, over the window (bot-mode-design §6.6.1, DD-159): what a conversation produced is
// the thing to look at, not something beside it. The side panels stay for working on a file; this
// shows it whole, and one button away from the panel. A page that wants it wraps its content in
// FilePreviewProvider; file tiles and file tags under it then open here.

/**
 * The window's preview of `scope`'s files, for what is under it. `takes`: which files; any the app
 * can show unless the page says less. Others, or all without a scope, open as they would.
 */
export function FilePreviewProvider({ scope, takes = showsInApp, children }: { scope: Scope; takes?: (path: string) => boolean; children: ReactNode }) {
  const [path, setPath] = useState<string | null>(null);
  const available = !!scope;
  const opener = useMemo<FilePreviewOpener | null>(() => (available ? { takes, open: setPath } : null), [available, takes]);
  return (
    <FilePreviewContext.Provider value={opener}>
      {children}
      {path && scope && <FilePreview key={path} path={path} session={scope.session} cwd={scope.cwd} onClose={() => setPath(null)} />}
    </FilePreviewContext.Provider>
  );
}

/** One file over the window, by what it is: a page, a document, an image, or text. */
export function FilePreview({ path, session, cwd, onClose }: { path: string; session: string; cwd: string; onClose: () => void }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const docs = useDocOpener();
  const name = baseName(path);
  const page = opensAsPage(path);
  const asDoc = opensAsDoc(path);
  const [source, setSource] = useState(false);
  /** A document moving to the panel stays open in finx. */
  const moving = useRef(false);
  const toPanel = () => {
    moving.current = true;
    onClose();
    if (page && !source) return showPage(st, session, path);
    if (asDoc && docs) return docs.open({ path });
    showFile(st, session, cwd, path);
  };
  return (
    <Dialog label={name} width="min(var(--md-rich-width), calc(100vw - 96px))" className="fpv" onClose={onClose}>
      <div className="fpv-head">
        <span className="fpv-name" title={path}>{name}</span>
        {(page || previewable(path)) && (
          <button
            className={`tb fpv-source ${source ? "on" : ""}`}
            aria-label={t("files.source")}
            title={source ? t("files.preview") : t("files.source")}
            aria-pressed={source}
            onClick={() => setSource(!source)}
          >
            <Icon name="code" />
          </button>
        )}
        <button className="tb fpv-panel" aria-label={t("preview.toPanel")} title={t("preview.toPanel")} onClick={toPanel}>
          <Icon name="infoCard" />
        </button>
        <button
          className="tb"
          aria-label={t("files.more")}
          title={t("files.more")}
          onClick={() => void fileMenu(st, { path, rel: relativeTo(cwd, path), kind: "file" }, undefined)}
        >
          <Icon name="more" />
        </button>
        <button className="tb fpv-close" aria-label={t("preview.close")} title={t("preview.close")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {/* The first thing with the keys, so the arrows and Page Down read on from the start. */}
      <div className="fpv-body" tabIndex={-1} ref={(el) => el?.setAttribute("autofocus", "")} onContextMenu={() => selectionMenu(st)}>
        {asDoc ? (
          <DocBody path={path} session={session} cwd={cwd} moving={moving} onLocked={toPanel} onClose={onClose} />
        ) : page && !source ? (
          <PageBody path={path} session={session} cwd={cwd} onClose={onClose} onSource={() => setSource(true)} />
        ) : (
          <TextBody path={path} session={session} source={source || page} onClose={onClose} />
        )}
      </div>
    </Dialog>
  );
}

/**
 * An HTML file, as the page it is. It runs in a view of its own over this room (browser/pagePreview),
 * never in the app's page. It opens once the dialog has laid the room out.
 */
function PageBody({ path, session, cwd, onClose, onSource }: { path: string; session: string; cwd: string; onClose: () => void; onSource: () => void }) {
  const st = useStore();
  const room = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const finx = window.finx;
    const el = room.current;
    if (!finx || !el) return;
    let opened = false;
    const rect = () => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const place = () => {
      const now = rect();
      if (now.width === 0 || now.height === 0) return;
      if (opened) return finx.placePagePreview(now);
      opened = true;
      void finx.openPagePreview(path, now).then((there) => there || onSource());
    };
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener("resize", place);
    const off = finx.onPagePreview((event) => {
      onClose();
      if (event.kind === "link") openLink(st, event.url, { session, cwd }, false);
    });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      off();
      finx.closePagePreview();
    };
  }, [path, session, cwd]);
  return <div ref={room} className="fpv-page" />;
}

/**
 * A PDF or a workbook, as the file panel shows it. A document this opened is let go of with it,
 * unless the panel has it too or it is moving there. One locked by a password goes to the panel, which asks.
 */
function DocBody({ path, session, cwd, moving, onLocked, onClose }: { path: string; session: string; cwd: string; moving: React.RefObject<boolean>; onLocked: () => void; onClose: () => void }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const docs = useSessionDocs(session);
  const rpc = st.rpc;
  const [docId, setDocId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(rpc ? null : t("files.offline"));
  useEffect(() => {
    if (!rpc) return;
    const had = docsOf(session).tabs.some((x) => x.info.path === path);
    let live = true;
    let opened: string | null = null;
    const letGo = () => {
      const shown = filesOf(session, cwd).tabs.some((x) => x.opened?.docId === opened);
      if (opened && !had && !moving.current && !shown) void closeDoc(rpc, session, opened);
    };
    openDoc(rpc, session, { path })
      .then((tab) => {
        opened = tab?.info.doc_id ?? null;
        if (!live) return letGo();
        if (tab) setDocId(tab.info.doc_id);
        else onLocked();
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
      letGo();
    };
  }, [path, session, cwd]);
  const tab = docs.tabs.find((x) => x.info.doc_id === docId);
  if (error) return <FileCard path={path} rel={relativeTo(cwd, path)} text={error} gone />;
  if (!tab || !rpc) return <FileLoading />;
  return (
    // A part of it quoted goes to the composer, under this: this goes first.
    <ContentScope value={{ session, cwd, leave: onClose }}>
      <div className="dcp-viewer">
        {tab.info.layout === "grid" ? <SheetView rpc={rpc} session={session} tab={tab} /> : <PdfView rpc={rpc} session={session} tab={tab} jump={null} />}
      </div>
    </ContentScope>
  );
}

/** Anything read as a file: Markdown as it reads, an image as it looks, other text as text. */
function TextBody({ path, session, source, onClose }: { path: string; session: string; source: boolean; onClose: () => void }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const [read, setRead] = useState<FilesReadResult | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    st.call("files/read", { session_id: session, path })
      .then((r) => live && setRead(r))
      .catch((e) => live && setRead({ error: errorText(e) }));
    return () => {
      live = false;
    };
  }, [path, session]);
  const name = baseName(path);
  const dir = parentOf(path);
  if (!read) return <FileLoading />;
  if ("error" in read) return <FileCard path={path} rel={null} text={read.error} gone />;
  if (read.kind === "image" && read.image) return <ImageView src={`data:${read.image.mime_type};base64,${read.image.data}`} alt={name} />;
  if (read.kind === "binary") return <FileCard path={path} rel={null} text={t("files.binary")} />;
  if (read.kind === "too_large") return <FileCard path={path} rel={null} text={t("files.tooLarge", { size: sizeText(read.size) })} />;
  const text = read.text ?? "";
  if (!source && isSvg(name)) return <ImageView src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`} alt={name} />;
  if (!source && isMarkdown(name)) {
    return (
      // Its links, paths and pictures are the file's own: relative to its folder. What opens beside the conversation closes this first.
      <ContentScope value={{ session, cwd: dir, leave: onClose }}>
        <LocalImages.Provider value={true}>
          <div className="fpv-read">
            <div className="fpv-col">
              <Markdown text={text} mode="document" />
            </div>
          </div>
        </LocalImages.Provider>
      </ContentScope>
    );
  }
  if (wraps(name)) return <div className="fpv-read"><pre className="fpv-col fpv-text sel-text">{text}</pre></div>;
  return (
    <ContentScope value={{ session, cwd: dir, leave: onClose }}>
      <div className="fpv-code md sel-text">
        <CodeBlock lang={/\.([A-Za-z0-9]+)$/.exec(name)?.[1].toLowerCase() ?? ""} text={text} />
      </div>
    </ContentScope>
  );
}
