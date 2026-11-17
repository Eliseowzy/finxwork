import { useContext, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { fileOfCode, fileOfLink, hiddenChars, loopback, shellLanguage, shortURL, webOf, webOfCode, type FileRef as Ref } from "@finx/client";
import { inSession, showFile, showFolder } from "../files/state";
import { Icon } from "../icons";
import { SiteIcon, siteOrigin } from "../siteIcon";
import { useStore } from "../store";
import { Code } from "./Code";
import { codeMenu, copyText, editorList, fileMenu, linkMenu, openLink, openRef, opensAsPage, otherView, showPage, terminalWith } from "./contentMenus";
import { DraftContext, OwnFilesOnly, useFileInfo, useScope, type Scope } from "./scope";

// What a conversation's content does (content-actions-design): the files and web pages a reply
// points at, and its code blocks. Read from the Markdown as it renders; nothing here acts
// until the person clicks, and nothing reaches the network or reads a file's contents.

const windows = () => window.finx?.platform === "win";

// ── files ──

/**
 * A file or folder a reply points at, as a tag (§4.1): its icon, name and lines; a click opens
 * it the person's way, a right click offers the rest. From inline code it shows only once the
 * path is found to exist; from a link it shows anyway, greyed when there is nothing there.
 */
function FileTag({ target, scope, code, children }: { target: Ref; scope: NonNullable<Scope>; code?: string; children?: ReactNode }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const info = useFileInfo(scope.cwd, target.path);
  const own = useContext(OwnFilesOnly);
  useEffect(() => void editorList(), []);
  if (code !== undefined && !info?.kind) return <code>{code}</code>;
  // Another subject's bot names a file: only its own folder means a file of ours (§8).
  if (own && !inSession(scope.cwd, info?.path ?? target.path)) return <span>{children ?? target.path}</span>;
  const missing = info?.kind === null;
  const folder = info ? info.kind === "folder" : /[\\/]$/.test(target.path);
  const where = info ? (info.rel ?? info.path) : target.path;
  const lines = target.line === undefined ? "" : target.endLine ? t("content.lines", { line: target.line, end: target.endLine }) : t("content.line", { line: target.line });
  // A reference to lines is to the source, even in an HTML file.
  const page = !!info && target.line === undefined && opensAsPage(info.path);
  // In the session's file panel (file-panel-design DD-91), an HTML file in its browser (DD-157); a folder outside the session's, in the file manager.
  const open = () => {
    if (!info) return;
    if (info.kind === null) return void openRef(st, info, target.line);
    scope.leave?.();
    if (info.kind === "folder") return inSession(scope.cwd, info.path) ? showFolder(st, scope.session, scope.cwd, info.path) : window.finx?.openFolder(info.path);
    if (page) return showPage(st, scope.session, info.path);
    showFile(st, scope.session, scope.cwd, info.path, { line: target.line, endLine: target.endLine });
  };
  const menu = () => {
    if (!info) return;
    const view = otherView(st, scope.session, scope.cwd, info.path, page ? "page" : "source");
    void fileMenu(st, info, target.line, open, view && { ...view, run: () => (scope.leave?.(), view.run()) });
  };
  return (
    <span
      className={`fref ${code !== undefined ? "mono" : ""} ${missing ? "gone" : ""}`}
      role="button"
      tabIndex={0}
      title={missing ? `${t("content.notFound")}\n${where}` : [where, lines].filter(Boolean).join(" · ")}
      onClick={(e) => {
        // Not when the click ends a selection that takes the tag in.
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.containsNode(e.currentTarget, true)) return;
        open();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") (e.preventDefault(), open());
        else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) (e.preventDefault(), menu());
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        menu();
      }}
    >
      <Icon name={folder ? "folder" : "file"} />
      <span className="fref-n">{code !== undefined ? target.path : children}</span>
      {target.line !== undefined && <span className="fref-l">{`:${target.line}${target.endLine ? `-${target.endLine}` : ""}`}</span>}
    </span>
  );
}

// ── web pages ──

/** Whether a link's words are its address itself (a bare one, or `www.` made into one). */
function bareText(children: ReactNode, url: URL): boolean {
  const text = typeof children === "string" ? children : Array.isArray(children) && children.length === 1 && typeof children[0] === "string" ? children[0] : null;
  if (text === null) return false;
  const t = text.trim();
  return webOf(/^https?:\/\//i.test(t) ? t : `http://${t}`)?.href === url.href;
}

/**
 * A web page a reply points at (§5): its site's icon (only one already kept, §5.1) or what
 * stands for it, and its words, a bare address shortened. A click opens it in the session's
 * browser; with ⌘ (Ctrl), or the middle button, in the default browser.
 */
function WebLink({ url, code, children }: { url: URL; code?: boolean; children: ReactNode }) {
  const st = useStore();
  const scope = useScope();
  const href = url.href;
  const label = bareText(children, url) ? shortURL(url) : children;
  const icon = (
    <span className="wl-i">{loopback(url.hostname) ? <Icon name="laptop" /> : <SiteIcon origin={siteOrigin(href)} fallback={<Icon name="globe" />} cached />}</span>
  );
  // The icon stays with the words' start: a line never ends on it.
  const words = typeof label === "string" ? [...label] : null;
  const shown = code ? (
    <span className="wl-g">{icon}<code>{label}</code></span>
  ) : words ? (
    <>
      <span className="wl-g">{icon}{words.slice(0, 12).join("")}</span>
      {words.slice(12).join("")}
    </>
  ) : (
    <>
      {icon}
      {label}
    </>
  );
  return (
    <a
      href={href}
      className="wl"
      title={href}
      onClick={(e) => {
        e.preventDefault();
        openLink(st, href, scope, e.metaKey || e.ctrlKey);
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        openLink(st, href, scope, true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void linkMenu(st, href, scope);
      }}
    >
      {shown}
    </a>
  );
}

/** A Markdown link: a web page, a file in the session, or (anything else, or still being written) its words alone. */
export function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const scope = useScope();
  const draft = useContext(DraftContext);
  if (!draft && href) {
    const url = webOf(href);
    if (url) return <WebLink url={url}>{children}</WebLink>;
    const file = scope ? fileOfLink(href, windows()) : null;
    if (file && scope) return <FileTag target={file} scope={scope}>{children}</FileTag>;
  }
  return <span>{children}</span>;
}

/** Inline code: a web address alone, a path that exists in the session, or code. */
export function InlineCode({ children }: { children?: ReactNode }) {
  const scope = useScope();
  const draft = useContext(DraftContext);
  if (!draft && typeof children === "string") {
    const url = webOfCode(children);
    if (url) return <WebLink url={url} code>{children}</WebLink>;
    const file = scope ? fileOfCode(children, windows()) : null;
    if (file && scope) return <FileTag target={file} scope={scope} code={children} />;
  }
  const color = typeof children === "string" && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(children.trim()) ? children.trim() : null;
  return <code>{color && <span className="md-color" aria-hidden="true" style={{ backgroundColor: color }} />}{children}</code>;
}

// ── code blocks ──

/**
 * A fenced block (§6): a bar with its language and Copy, and for a shell's block Open in
 * Terminal (the command copied, to paste there); a warning when it holds characters that do
 * not show. The block still being written has no buttons yet.
 */
export function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const scope = useScope();
  const draft = useContext(DraftContext);
  const [done, setDone] = useState(false);
  const shell = shellLanguage(lang);
  const copy = () => void copyText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)));
  return (
    <div
      className="cblock"
      onContextMenu={(e) => {
        if (draft) return;
        e.preventDefault();
        e.stopPropagation();
        void codeMenu(st, text, shell, scope);
      }}
    >
      <div className="cb-h">
        {lang && (
          <span className="cb-lang">
            {shell && <Icon name="terminal" />}
            {lang}
          </span>
        )}
        {hiddenChars(text) && (
          <span className="cb-warn" title={t("content.hiddenTip")}>
            <Icon name="warn" />
            {t("content.hidden")}
          </span>
        )}
        {!draft && (
          <span className="cb-acts">
            <button className="cb-b" onClick={copy} aria-label={t("content.copy")}>
              <Icon name={done ? "check" : "copy"} />
              {t("content.copy")}
            </button>
            {shell && scope && (
              <button className="cb-b" onClick={() => terminalWith(st, scope, text)}>
                <Icon name="terminal" />
                {t("content.openTerminal")}
              </button>
            )}
          </span>
        )}
      </div>
      <pre>
        <code className={lang ? `language-${lang}` : undefined}>{lang ? <Code text={text} lang={lang} /> : text}</code>
      </pre>
    </div>
  );
}
