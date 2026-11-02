import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { WebComment } from "@finx/client";
import { Icon } from "../icons";
import { SiteIcon, siteOrigin } from "../siteIcon";

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
export function Tile({ kind, path, name, src, web, onRemove }: {
  kind: "file" | "folder" | "image" | "web";
  web?: WebComment;
  path?: string;
  name?: string;
  /** An image's data URL. */
  src?: string;
  onRemove?: () => void;
}) {
  const { t } = useTranslation("session");
  const [large, setLarge] = useState(false);
  const label = name ?? t("chat.image");
  const open = () => (src ? setLarge(true) : kind !== "web" && path && window.finx?.revealPath(path));
  const type = web ? hostOf(web.url) : kindOf(name ?? "", kind === "folder", t("composer.folder"));
  const title = web ? [web.comment, web.text && `“${web.text}”`, `<${web.tag}> · ${web.title || web.url}`, web.url].filter(Boolean).join("\n") : path;
  return (
    <div className={`tile ${src ? "img" : "doc"} ${web ? "web" : ""}`} title={title}>
      <button className="tile-open" onClick={open} aria-label={src ? t("composer.view", { name: label }) : web ? `${type}: ${label}` : t("composer.reveal", { name: label })}>
        {src ? (
          <img src={src} alt="" />
        ) : (
          <>
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
    </div>
  );
}

/** An image over the whole window; a click anywhere or Esc closes it. */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
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
