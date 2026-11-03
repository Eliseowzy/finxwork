import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { baseName, type DocQuote, type WebComment } from "@finx/client";
import { opensAsDoc, useDocOpener } from "../docs/state";
import { Icon } from "../icons";
import { SiteIcon, siteOrigin } from "../siteIcon";
import { quoteName, webName } from "./attachments";

// What a message carries, as square tiles, the same in the composer and in
// the conversation: an image shows itself and opens large over the window;
// a file or folder shows its name and type and opens in the file manager.

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
export function Tile({ kind, path, name, src, web, quote, shot, onRemove }: {
  kind: "file" | "folder" | "image" | "web" | "doc";
  web?: WebComment;
  /** A quoted part of a document: shows where it is from, and opens there. */
  quote?: DocQuote;
  path?: string;
  name?: string;
  /** An image's data URL. */
  src?: string;
  /** A part of a page's or a quoted region's picture, as a data URL: shown in its details, not as a tile of its own. */
  shot?: string;
  onRemove?: () => void;
}) {
  const { t } = useTranslation("session");
  const [large, setLarge] = useState(false);
  const [details, setDetails] = useState(false);
  const tile = useRef<HTMLDivElement>(null);
  const label = name ?? (web ? webName(web) : quote ? quoteName(quote) : t("chat.image"));
  const docs = useDocOpener();
  // A PDF opens beside the conversation; ⌥ shows it in the file manager as before.
  const open = (e: React.MouseEvent) => {
    if (src) return setLarge(true);
    if (web || quote) return setDetails((d) => !d);
    if (!path) return;
    if (docs && kind === "file" && opensAsDoc(path) && !e.altKey) return docs.open({ path });
    window.finx?.revealPath(path);
  };
  const pages = !quote ? "" : quote.to_page && quote.to_page !== quote.page ? t("doc.pageRange", { from: quote.page, to: quote.to_page }) : t("doc.pageN", { page: quote.page });
  const where = !quote ? "" : `${baseName(quote.path)} · ${pages}`;
  const type = web ? hostOf(web.url) : quote ? pages : kindOf(name ?? "", kind === "folder", t("composer.folder"));
  const title = web ? [web.comment, web.text && `“${web.text}”`, `<${web.tag}> · ${web.title || web.url}`, web.url].filter(Boolean).join("\n") : quote ? [quote.comment, where, quote.text].filter(Boolean).join("\n") : path;
  const quoteKind = !quote ? "" : quote.comment ? t("doc.comment") : quote.region ? t("doc.region") : t("doc.quote");
  return (
    <div ref={tile} className={`tile ${src ? "img" : "doc"} ${web ? "web" : ""} ${quote ? "quote" : ""}`} title={details ? undefined : title}>
      <button className="tile-open" onClick={open} aria-expanded={web || quote ? details : undefined} aria-label={src ? t("composer.view", { name: label }) : web || quote ? `${type}: ${label}` : t("composer.reveal", { name: label })}>
        {src ? (
          <img src={src} alt="" />
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
            <span className="tile-name">{label}</span>
            {type && <span className="tile-kind">{type}</span>}
          </>
        )}
      </button>
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
          action={docs ? { label: t("composer.webDetails.openDoc"), run: () => (setDetails(false), docs.open({ doc_id: quote.doc_id }, quote.block ? undefined : { kind: "page", page: quote.page }, quote.block)) } : undefined}
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

/** An image over the whole window; a click anywhere or Esc closes it. */
export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    // Ahead of everything else that listens for Esc (an approval, a menu).
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <img src={src} alt="" />
    </div>,
    document.body,
  );
}
