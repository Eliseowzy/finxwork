import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { displayTitle, runningAgents, type ListSession } from "@finx/client";
import { SidebarToggle } from "../components";
import { GlassBar } from "../glass";
import { Icon } from "../icons";
import { DocContext, docsOf, lockedPath, type DocOpener } from "../docs/state";
import { layoutOf, setCard } from "../layout";
import { useStore } from "../store";
import { FilePanel } from "../files/FilePanel";
import { filesChanged, isPasswordError, lockedOut, setFilesConnection, showDoc, useDocEvents } from "../files/state";
import { Background } from "./Background";
import { BrowserPanel, useBrowserTabs } from "./Browser";
import { Chat } from "./Chat";
import { selectionMenu } from "./contentMenus";
import { Inspector } from "./Inspector";
import { ContentScope, recheckFiles } from "./scope";
import { useSession } from "./useSession";

// A session: its conversation, the composer and the bar of a running task,
// with the info card over its right side, or in its place the background
// card once it has sub-agents; the browser as a column of its own.
export function SessionPage({ s }: { s: ListSession }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const [view, loadEarlier] = useSession(s.session_id);
  const agents = view?.agents.length ?? 0;
  const running = view ? runningAgents(view).length : 0;
  const browserTabs = useBrowserTabs().filter((t) => t.session === s.session_id);
  const background = st.background && agents > 0;
  const cwd = view?.info.cwd;
  useDocEvents(st.rpc, s.session_id, cwd);
  // One panel on the right at a time: the background panel when asked for, else the file panel when
  // opened (file-panel-design §3.1), its PDFs too (document-editor-design §7.1), else the browser.
  const files = st.files && !background && !!view;
  const browser = st.browser && browserTabs.length > 0 && !background && !files;
  // Taking the window, the panel leaves the conversation mounted but out of sight, where it was.
  const max = (browser && st.browserMax) || (files && st.filesMax);
  const rpc = st.rpc;
  const opener = useMemo<DocOpener | null>(() => {
    if (!rpc || !cwd) return null;
    const id = s.session_id;
    return {
      session: id,
      open: (what, anchor, target) =>
        void st.run(async () => {
          const shown = await showDoc(st, id, cwd, what, anchor);
          // A citation's block or page, once its document is open in the session (not while it asks for its password).
          if (shown && target && "doc_id" in what) {
            try {
              const r = await rpc.request("doc/locate", { session_id: id, doc_id: what.doc_id, target });
              await showDoc(st, id, cwd, what, r.anchor);
            } catch (e) {
              // Its file changed and wants its password again: the tab asks for it, not a toast.
              if (!(await lockedOut(id, what.doc_id, e))) throw e;
            }
          }
        }),
      locate: async (docId, target) => {
        const known = docsOf(id).tabs.find((t) => t.info.doc_id === docId)?.info.path;
        try {
          // A hover must not bring the column out: finx opens the document, the column stays as it is.
          const path = known ?? (await rpc.request("doc/open", { session_id: id, doc_id: docId })).info.path;
          const r = await rpc.request("doc/locate", { session_id: id, doc_id: docId, target });
          return { anchor: r.anchor, path };
        } catch (e) {
          // Encrypted, its password not given yet (or changed): still there, a click asks for it.
          const path = lockedPath(e) ?? (isPasswordError(e) ? known : null);
          return path ? { locked: true, path } : null;
        }
      },
    };
  }, [rpc, s.session_id, cwd]);
  const layout = layoutOf(st);
  const info = layout.card !== "hidden" && !background && !browser && !files;
  // The background card keeps the conversation clear of it as the info card does, when there is room for one.
  const dock = (info && layout.card === "docked") || (background && layoutOf({ ...st, inspector: true, peek: null }).card === "docked");
  // The first page the session opens brings the browser panel out.
  const hasTabs = browserTabs.length > 0;
  useEffect(() => {
    // Not over the file panel, which the person opened.
    if (hasTabs && !st.files) st.set({ browser: true, background: false });
  }, [hasTabs, s.session_id]);
  // What finx says changed on disk reaches the file panel's files, whichever session they are in.
  useEffect(() => {
    setFilesConnection(st.rpc);
    return st.rpc?.on("files/changed", (p) => filesChanged(p.session_id, p.paths));
  }, [st.rpc]);
  // What the conversation's content belongs to (content-actions-design §3.4): its paths are under the session's folder.
  const scope = useMemo(() => (cwd ? { session: s.session_id, cwd } : null), [s.session_id, cwd]);
  // A task that ended may have made or removed the files the replies point at.
  const ended = view?.entries.filter((e) => e.type === "task_end").length ?? 0;
  useEffect(() => recheckFiles(), [ended]);
  // `/context` answered: the card shows, its context section open.
  const asked = view?.asked?.at;
  useEffect(() => {
    if (asked === undefined) return;
    setCard(st, true);
    st.set({ contextOpen: true });
  }, [asked]);
  return (
    <DocContext.Provider value={opener}>
    <div className={`spage ${browser || files ? "bgopen" : ""} ${max ? "brmax" : ""}`}>
      <div className="scol">
        <GlassBar className="ctool drag">
          <SidebarToggle />
          {/* The title moves the window like the rest of the bar; renaming lives in the sidebar. */}
          <div className="ctitle">
            <h2 title={displayTitle(s)}>{displayTitle(s)}</h2>
          </div>
          {/* A toolbar button as the sidebar's toggle is, highlighted while the info shows. */}
          <button
            className={`tb ${info ? "on" : ""}`}
            title={t("page.infoTip")}
            aria-label={t("page.info")}
            aria-pressed={info}
            onClick={() => setCard(st, !info)}
          >
            <Icon name="infoCard" />
          </button>
          {/* The background panel's button, with how many tasks run; only for a session that has some. */}
          {agents > 0 && (
            <button
              className={`tb ${background ? "on" : ""}`}
              title={t("background.title")}
              aria-label={t("background.title")}
              aria-pressed={background}
              onClick={() => st.set({ background: !background })}
            >
              <Icon name="layers" />
              {running > 0 && <span className="tb-badge">{running}</span>}
            </button>
          )}
          {/* The browser panel's button; a session with no pages yet gets a blank tab to start from. While the
              panel is open it sits at the panel's right end instead, where it puts the panel away. */}
          {window.finx && !browser && (
            <button
              className="tb"
              title={t("browser.builtIn")}
              aria-label={t("browser.builtIn")}
              aria-pressed={false}
              onClick={() => {
                if (hasTabs) st.set({ browser: true, background: false, files: false, filesMax: false });
                else void st.run(async () => {
                  await window.finx?.openBrowser(s.session_id);
                  st.set({ browser: true, background: false, files: false, filesMax: false });
                });
              }}
            >
              <Icon name="globe" />
            </button>
          )}
          {/* The file panel's button: the session's folder and the files opened from it. While the panel is
              open it sits at the panel's right end instead, where it puts the panel away (file-panel-design §3.2). */}
          {!files && (
            <button
              className="tb"
              title={t("files.title")}
              aria-label={t("files.title")}
              aria-pressed={false}
              onClick={() => {
                st.set({ files: true, browser: false, browserMax: false, background: false });
              }}
            >
              <Icon name="folder" />
            </button>
          )}
        </GlassBar>
        {/* The conversation keeps clear of the card beside it; a card over it (no room) leaves it be. */}
        <ContentScope value={scope}>
          {/* Right-click on selected text: Copy (anything with a menu of its own shows that instead). */}
          <div className={`dwrap ${dock ? "dock" : ""}`} onContextMenu={() => selectionMenu(st)}>
            <div className="dmain">{view ? <Chat s={s} view={view} loadEarlier={loadEarlier} /> : <div className="empty"><span className="mini-spin" /></div>}</div>
            {view && info && <Inspector s={s} view={view} />}
            {view && background && <Background s={s} view={view} />}
          </div>
        </ContentScope>
      </div>
      {files && view && (
        <FilePanel
          session={s.session_id}
          cwd={view.info.cwd}
          max={st.filesMax}
          onMax={(m) => st.set({ filesMax: m })}
          onClose={() => st.set({ files: false, filesMax: false })}
        />
      )}
      {browser && (
        <BrowserPanel
          session={s.session_id}
          tabs={browserTabs}
          max={max}
          onMax={(m) => st.set({ browserMax: m })}
          onClose={() => st.set({ browser: false, browserMax: false })}
        />
      )}
    </div>
    </DocContext.Provider>
  );
}
