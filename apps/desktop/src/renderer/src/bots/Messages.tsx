import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { imageRatio, imageRows, type BotFile } from "@finx/client";
import { Lightbox, Tile, useOpenFile } from "../composer/Tile";
import { sizeText } from "../format";
import { Markdown } from "../session/Markdown";
import { fileMenu } from "../session/contentMenus";
import { useFileInfo, useScope } from "../session/scope";
import { useStore } from "../store";

// What a bot sends besides words (docs/desktop/bot-mode-design.md §6.6.1, §6.6.2).

/** A file's native menu, the same as a file tag's. */
function useFileMenu() {
  const st = useStore();
  const scope = useScope();
  const openFile = useOpenFile();
  return (e: MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    void window.finx?.pathInfo(scope?.cwd ?? "", [path]).then(([info]) => info && fileMenu(st, info, undefined, () => openFile(path)));
  };
}

/** The pictures of a message, as data URLs; null for one that cannot be read as a picture any more. */
function useImages(files: BotFile[]) {
  const st = useStore();
  const session = useScope()?.session;
  const [pictures, setPictures] = useState<Record<string, string | null>>({});
  const paths = files.filter((f) => f.image).map((f) => f.path);
  useEffect(() => {
    if (!session) return;
    let live = true;
    const keep = (path: string, picture: string | null) => live && setPictures((p) => ({ ...p, [path]: picture }));
    for (const path of paths) {
      st.call("files/read", { session_id: session, path })
        .then((read) => keep(path, read.image ? `data:${read.image.mime_type};base64,${read.image.data}` : null))
        .catch(() => keep(path, null));
    }
    return () => {
      live = false;
    };
  }, [session, paths.join("\0")]);
  return pictures;
}

/** A message of files: its words if it has any, its images together, then its other files together. */
export function SentFiles({ files, text }: { files: BotFile[]; text?: string }) {
  const pictures = useImages(files);
  const images = files.filter((f) => f.image && pictures[f.path] !== null);
  const others = files.filter((f) => !images.includes(f));
  return (
    <div className="batt">
      {text !== undefined && (
        <div className="bbub">
          <Markdown text={text} />
        </div>
      )}
      {images.length > 0 && <ImageGroup files={images} pictures={pictures} />}
      {others.length > 0 && (
        <div className="bfiles">
          {others.map((f, i) => (
            <FileRow key={i} file={f} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One image with its own proportions, or several in rows of two or three: one height in a row,
 * so a chart keeps its axes. Its size is known before the picture is read, so nothing moves.
 */
function ImageGroup({ files, pictures }: { files: BotFile[]; pictures: Record<string, string | null> }) {
  const { t } = useTranslation("session");
  const menu = useFileMenu();
  const [large, setLarge] = useState<number | null>(null);
  const alone = files.length === 1;
  let at = 0;
  const rows = imageRows(files.length).map((count) => {
    const row = { from: at, files: files.slice(at, at + count) };
    at += count;
    return row;
  });
  const shown = large === null ? undefined : files[large];
  const picture = shown && pictures[shown.path];
  return (
    <div
      className={`bims ${alone ? "one" : ""}`}
      style={alone ? ({ "--r": imageRatio(files[0], true), "--w": files[0].width ? `${files[0].width}px` : "480px" } as CSSProperties) : undefined}
    >
      {rows.map((row) => (
        <div key={row.from} className="bims-r">
          {row.files.map((f, i) => (
            <button
              key={i}
              className="bim"
              style={{ "--r": imageRatio(f, alone) } as CSSProperties}
              title={f.path}
              aria-label={t("composer.view", { name: f.name })}
              onClick={() => setLarge(row.from + i)}
              onContextMenu={(e) => menu(e, f.path)}
            >
              {pictures[f.path] && <img src={pictures[f.path]!} alt="" draggable={false} />}
            </button>
          ))}
        </div>
      ))}
      {shown && picture && (
        <Lightbox
          src={picture}
          caption={alone ? shown.name : `${large! + 1} / ${files.length}  ·  ${shown.name}`}
          onStep={alone ? undefined : (d) => setLarge(((large ?? 0) + d + files.length) % files.length)}
          onClose={() => setLarge(null)}
        />
      )}
    </div>
  );
}

/** A file: a row in the message's bubble, greyed once it is gone. */
function FileRow({ file }: { file: BotFile }) {
  const { t } = useTranslation("bots");
  const scope = useScope();
  const menu = useFileMenu();
  const info = useFileInfo(scope?.cwd ?? "", file.path);
  const gone = info?.kind === null;
  return (
    <Tile
      kind="file"
      path={file.path}
      name={file.name}
      meta={gone ? t("chat.fileGone") : sizeText(file.size)}
      gone={gone}
      onContextMenu={(e) => menu(e, file.path)}
    />
  );
}

/**
 * A question, with answers to tap if they can be listed. A tapped answer is the owner's message
 * like any other; once they said anything, the options fold away and it reads as an ordinary
 * exchange. Without options it is a bubble like any other.
 */
export function Question({ text, options, open, onAnswer }: { text: string; options: string[]; open: boolean; onAnswer: (label: string) => Promise<boolean> }) {
  // A moment after it closes, for the options to fold.
  const [shown, setShown] = useState(open);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (open) return setShown(true);
    const fold = setTimeout(() => setShown(false), 260);
    return () => clearTimeout(fold);
  }, [open]);
  const answer = async (label: string) => {
    setSending(true);
    if (!(await onAnswer(label))) setSending(false);
  };
  return (
    <div className={`bbub bq ${open && options.length > 0 ? "" : "done"}`}>
      <div className="bq-q">
        <Markdown text={text} />
      </div>
      {shown && options.length > 0 && (
        <div className={`bq-fold ${open ? "" : "shut"}`}>
          <div className="bq-opts">
            {options.map((label) => (
              <button key={label} className="bq-opt" disabled={!open || sending} onClick={() => void answer(label)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
