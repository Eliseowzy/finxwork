import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { baseName, type DocQuote, type MessageQuote, type WebComment } from "@finx/client";
import { useDocOpener } from "../docs/state";
import { isLegacyWord, isPresentation, isWord, mayBeStudy, opensAsDoc, opensInOwnApp } from "../files/kind";
import { Icon } from "../icons";
import { opensAsPage, showPage } from "../session/contentMenus";
import { useScope } from "../session/scope";
import { showFile } from "../files/state";
import { SiteIcon, siteOrigin } from "../siteIcon";
import { useStore } from "../store";
import { quoteName, saidName, saidWords, webName } from "./attachments";

// What a message carries, as square tiles, the same in the composer and in
// the conversation: an image shows itself and opens large over the window;
// a file shows its name and type and opens in the panel or its own app; a folder opens in the file manager.

/** A file's type as a tile shows it: its extension, upper case ("HTML"); a folder's, "folder". */
export function kindOf(path: string, folder: boolean, folderWord: string): string {
  if (folder) return folderWord;
  const ext = /\.([A-Za-z0-9]{1,6})$/.exec(path)?.[1];
  return ext ? ext.toUpperCase() : "";
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * One attachment. An image with no path (one from a sent message) has no name to show; it only opens large.
 * A part of a web page shows what was said about it, or its text, and the site.
 */
export function Tile({ kind, path, name, src, web, quote, said, shot, meta, gone, onContextMenu, onRemove, onOpen }: {
  kind: "file" | "folder" | "image" | "web" | "doc" | "said" | "tabs";
  web?: WebComment;
  /** A quoted part of a document: shows where it is from, and opens there. */
  quote?: DocQuote;
  /** A part of the conversation: shows who said it, and opens it there unless it is gone. */
  said?: MessageQuote;
  path?: string;
  name?: string;
  /** An image's data URL. */
  src?: string;
  /** A part of a page's or a quoted region's picture, as a data URL: shown in its details, not as a tile of its own. */
  shot?: string;
  /** A file's second line instead of its type. */
  meta?: string;
  /** The file is no longer there: it shows, and opens nothing. */
  gone?: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
  onRemove?: () => void;
  /** Opens a quote of the conversation where it was said. */
  onOpen?: () => void;
}) {
  const { t } = useTranslation("session");
  const [large, setLarge] = useState(false);
  const [details, setDetails] = useState(false);
  const tile = useRef<HTMLDivElement>(null);
  const label = name ?? (web ? webName(web) : quote ? quoteName(quote) : said ? saidName(said) : t("chat.image"));
  const docs = useDocOpener();
  const openFile = useOpenFile();
  const scope = useScope();
  const st = useStore();
  /** A text file's quote opens at its lines in the file panel. */
  const openLines = (file: string, [line, endLine]: [number, number]) => (scope ? showFile(st, scope.session, scope.cwd, file, { line, endLine }) : openFile(file));
  // A folder opens in the file manager, a file as openFile does; ⌥ shows it in the file manager.
  const open = (e: React.MouseEvent) => {
    if (src) return setLarge(true);
    if (said) return gone ? undefined : onOpen?.();
    if (web || quote) return setDetails((d) => !d);
    if (!path || gone) return;
    if (e.altKey) return window.finx?.revealPath(path);
    if (kind === "folder") return window.finx?.openFolder(path);
    openFile(path);
  };
  const pages = !quote ? "" : quote.lines ? (quote.lines[0] === quote.lines[1] ? t("doc.lineN", { line: quote.lines[0] }) : t("doc.lineRange", { from: quote.lines[0], to: quote.lines[1] })) : quote.paragraphs && quote.page === undefined ? t("doc.paragraphs", { count: quote.paragraphs.length }) : quote.sheet && quote.range ? `${quote.sheet}!${quote.range}` : quote.to_page && quote.to_page !== quote.page ? t("doc.pageRange", { from: quote.page, to: quote.to_page }) : t("doc.pageN", { page: quote.page });
  const where = !quote ? "" : `${baseName(quote.path)} · ${pages}`;
  const type = web ? hostOf(web.url) : quote ? pages : said ? "" : kind === "tabs" ? t("composer.tabKind") : kindOf(name ?? "", kind === "folder", t("composer.folder"));
  const title = said ? (gone ? t("quote.gone") : undefined) : web ? [web.comment, web.text && `“${web.text}”`, `<${web.tag}> · ${web.title || web.url}`, web.url].filter(Boolean).join("\n") : quote ? [quote.comment, where, quote.text].filter(Boolean).join("\n") : path;
  const quoteKind = !quote ? "" : quote.comment ? t("doc.comment") : quote.region ? t("doc.region") : t("doc.quote");
  const plain = !src && !web && !quote && !said;
  const dot = label.lastIndexOf(".");
  return (
    <div ref={tile} className={`tile ${src ? "img" : "doc"} ${web ? "web" : ""} ${quote ? "quote" : ""} ${said ? `said ${said.role}` : ""} ${plain ? "file" : ""} ${gone ? "gone" : ""}`} title={details ? undefined : title} onContextMenu={onContextMenu}>
      <button className="tile-open" onClick={open} aria-expanded={web || quote ? details : undefined} aria-label={src ? t("composer.view", { name: label }) : web || quote ? `${type}: ${label}` : said ? label : t("composer.reveal", { name: label })}>
        {src ? (
          <img src={src} alt="" />
        ) : plain ? (
          <>
            {kind === "tabs" ? (
              <span className="tile-badge f-tabs" aria-hidden>
                <Icon name="globe" />
              </span>
            ) : (
              <FileBadge path={name ?? path ?? ""} folder={kind === "folder"} />
            )}
            <span className="tile-text">
              <span className="tile-name">
                <span className="tile-stem">{dot > 0 ? label.slice(0, dot) : label}</span>
                {dot > 0 && <span className="tile-ext">{label.slice(dot)}</span>}
              </span>
              {(meta ?? type) && <span className="tile-kind">{meta ?? type}</span>}
            </span>
          </>
        ) : (
          <>
            {quote && (
              <span className="tile-web">
                <Icon name="doc" />
                {quoteKind}
              </span>
            )}
            {web && (
              <span className="tile-web">
                <SiteIcon origin={siteOrigin(web.url)} fallback={<Icon name="globe" />} />
                {web.comment ? t("composer.webComment") : t("composer.webElement")}
              </span>
            )}
            {said && (
              <span className="tile-web">
                <Icon name="quote" />
                {t("content.quote")}
              </span>
            )}
            <span className="tile-name">{label}</span>
            {type && <span className="tile-kind">{type}</span>}
          </>
        )}
      </button>
      {said && !gone && <span className="tip tile-said-tip" aria-hidden="true">{saidWords(said)}</span>}
      {onRemove && (
        <button className="tile-x" aria-label={t("composer.remove", { name: label })} onClick={onRemove}>
          <Icon name="x" />
        </button>
      )}
      {large && src && <Lightbox src={src} onClose={() => setLarge(false)} />}
      {details && web && (
        <Details
          anchor={tile}
          onClose={() => setDetails(false)}
          icon={<SiteIcon origin={siteOrigin(web.url)} fallback={<Icon name="globe" />} />}
          kind={web.comment ? t("composer.webComment") : t("composer.webElement")}
          where={hostOf(web.url)}
          shot={shot}
          comment={web.comment}
          rows={[[t("composer.webDetails.element"), elementName(web)], ...(web.text ? [[t("composer.webDetails.text"), web.text] as Row] : [])]}
          more={[...(web.title ? [[t("composer.webDetails.page"), web.title] as Row] : []), [t("composer.webDetails.link"), web.url], [t("composer.webDetails.selector"), web.selector, true]]}
        />
      )}
      {details && quote && (
        <Details
          anchor={tile}
          onClose={() => setDetails(false)}
          icon={<Icon name="doc" />}
          kind={quoteKind}
          where={pages}
          shot={shot}
          comment={quote.comment}
          rows={[[t("composer.webDetails.file"), baseName(quote.path)], ...(quote.text ? [[t("composer.webDetails.text"), quote.text] as Row] : [])]}
          more={[]}
          action={quote.lines ? { label: t("composer.webDetails.openDoc"), run: () => (setDetails(false), openLines(quote.path, quote.lines!)) } : quote.paragraphs && quote.page === undefined ? { label: t("composer.webDetails.openDoc"), run: () => (setDetails(false), openFile(quote.path)) } : docs ? { label: t("composer.webDetails.openDoc"), run: () => (setDetails(false), quote.sheet && quote.range ? docs.open({ doc_id: quote.doc_id }, { kind: "cells", sheet: quote.sheet, range: quote.range }) : docs.open({ doc_id: quote.doc_id }, quote.anchor ?? (quote.block ? undefined : { kind: "page", page: quote.page ?? 1 }), quote.anchor ? undefined : quote.block)) } : undefined}
        />
      )}
    </div>
  );
}

/** The element's tag with its id or first class, as the selector's last step names it ("h1.article-title"). */
function elementName(web: WebComment) {
  const last = web.selector.split(">").at(-1)?.trim() ?? "";
  const named = /^[a-z0-9-]+(?:#[^.:\s[]+|\.[^.:\s[]+)/i.exec(last)?.[0];
  return `<${named ?? web.tag}>`;
}

type Row = [label: string, value: string, mono?: boolean];

/**
 * A part of a page or of a document as it goes with the message: its picture, what was said,
 * and what and where it is, over the tile; a click outside or Esc closes it.
 */
function Details({ anchor, onClose, icon, kind, where, shot, comment, rows, more, action }: {
  anchor: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  icon: React.ReactNode;
  kind: string;
  where: string;
  /** The picture's data URL. */
  shot?: string;
  comment?: string;
  rows: Row[];
  more: Row[];
  action?: { label: string; run: () => void };
}) {
  const { t } = useTranslation("session");
  const card = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<React.CSSProperties>({ visibility: "hidden" });
  const [large, setLarge] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Above the tile when there is room, else below it; never past the window's edges.
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      const c = card.current;
      if (!r || !c) return;
      const w = c.offsetWidth, h = c.offsetHeight;
      const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left));
      const top = r.top - h - 8 >= 12 ? r.top - h - 8 : Math.min(window.innerHeight - h - 12, r.bottom + 8);
      setAt({ left, top: Math.max(12, top) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [shot, loaded]);

  useEffect(() => {
    if (large) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const down = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!card.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", down, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", down, true);
    };
  }, [large, onClose]);

  const list = (items: Row[]) => (
    <dl className="wdt-rows">
      {items.map(([k, v, mono]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className={mono ? "mono" : undefined}>{v}</dd>
        </div>
      ))}
    </dl>
  );
  return createPortal(
    <div ref={card} className="wdt" role="dialog" aria-label={kind} style={at}>
      <div className="wdt-head">
        {icon}
        <span className="wdt-kind">{kind}</span>
        <span className="wdt-host" title={where}>{where}</span>
        <button className="wdt-x" aria-label={t("composer.webDetails.close")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {shot && (
        <button className="wdt-shot" aria-label={t("composer.view", { name: kind })} onClick={() => setLarge(true)}>
          <img src={shot} alt="" onLoad={() => setLoaded(true)} />
        </button>
      )}
      {comment && <p className="wdt-comment">{comment}</p>}
      {rows.length > 0 && list(rows)}
      {more.length > 0 && (
        <details className="wdt-more">
          <summary>{t("composer.webDetails.more", { count: more.length })}</summary>
          {list(more)}
        </details>
      )}
      {action && (
        <button className="wdt-go" onClick={action.run}>
          {action.label}
        </button>
      )}
      {large && shot && <Lightbox src={shot} onClose={() => setLarge(false)} />}
    </div>,
    document.body,
  );
}

/**
 * An image over the whole window; a click anywhere or Esc closes it. With onStep, one of several:
 * arrows and the ← → keys go through them. caption: what it is, under it.
 */
export function Lightbox({ src, caption, onStep, onClose }: { src: string; caption?: string; onStep?: (by: 1 | -1) => void; onClose: () => void }) {
  const { t } = useTranslation("session");
  useEffect(() => {
    // Ahead of everything else that listens for Esc (an approval, a menu).
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (onStep && e.key === "ArrowLeft") onStep(-1);
      else if (onStep && e.key === "ArrowRight") onStep(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose, onStep]);
  const step = (by: 1 | -1) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onStep?.(by);
  };
  return createPortal(
    <div className={`lightbox ${onStep ? "many" : ""}`} role="dialog" aria-modal="true" onClick={onClose}>
      <img src={src} alt="" />
      {caption && <div className="lb-cap">{caption}</div>}
      {onStep && (
        <>
          <button className="lb-go prev" aria-label={t("composer.prevImage")} title={t("composer.prevImage")} onClick={step(-1)}>
            <Icon name="chevL" />
          </button>
          <button className="lb-go next" aria-label={t("composer.nextImage")} title={t("composer.nextImage")} onClick={step(1)}>
            <Icon name="chevR" />
          </button>
        </>
      )}
    </div>,
    // Inside the dialog open over the window, if any: nothing outside one shows above it.
    [...document.querySelectorAll("dialog[open]")].at(-1) ?? document.body,
  );
}

/**
 * Opens a file beside the conversation (a PDF as a document, Markdown previewed, an HTML file as its page); one that
 * shows only as "binary" in its own app.
 */
export function useOpenFile() {
  const docs = useDocOpener();
  const st = useStore();
  return (path: string) => {
    if (docs && opensAsPage(path)) return showPage(st, docs.session, path);
    if (docs && (opensAsDoc(path) || mayBeStudy(path) || isPresentation(path) || isWord(path) || isLegacyWord(path))) return docs.open({ path });
    if (!docs || opensInOwnApp(path)) return void window.finx?.openFile(path, { app: "system" });
    docs.open({ path });
  };
}

/** A file type's family, for its badge's colour. */
const families: [string, RegExp][] = [
  ["pdf", /^pdf$/],
  ["word", /^(docx?|rtf|odt|pages)$/],
  ["sheet", /^(xlsx?|xlsm|csv|tsv|ods|numbers)$/],
  ["slide", /^(pptx?|odp|key)$/],
  ["image", /^(png|jpe?g|gif|webp|svg|heic|bmp|ico|tiff?)$/],
  ["media", /^(mp3|m4a|wav|aac|flac|mp4|mov|m4v|avi|mkv|webm)$/],
  ["archive", /^(zip|rar|7z|tar|gz|dmg|pkg)$/],
  ["text", /^(md|markdown|txt|log|epub)$/],
  ["code", /^(js|jsx|ts|tsx|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|zsh|json|ya?ml|toml|xml|html?|css|scss|sql|lua)$/],
];

/** A small page in the file type's colour with its extension on it; a folder for a folder. */
function FileBadge({ path, folder }: { path: string; folder: boolean }) {
  if (folder)
    return (
      <span className="tile-badge f-folder" aria-hidden>
        <Icon name="folder" />
      </span>
    );
  const ext = (/\.([A-Za-z0-9]{1,6})$/.exec(path)?.[1] ?? "").toLowerCase();
  const family = families.find(([, re]) => re.test(ext))?.[0] ?? "other";
  return (
    <span className={`tile-badge f-${family}`} aria-hidden>
      <Icon name="file" />
      <b>{ext.slice(0, 4) || "FILE"}</b>
    </span>
  );
}
