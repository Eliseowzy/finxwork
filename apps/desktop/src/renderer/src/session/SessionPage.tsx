import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { displayTitle, runningAgents, type ListSession } from "@finx/client";
import { rename } from "../actions";
import { RenameField, SidebarToggle } from "../components";
import { GlassBar } from "../glass";
import { Icon } from "../icons";
import { layoutOf, setCard } from "../layout";
import { useStore } from "../store";
import { Background } from "./Background";
import { BrowserPanel, useBrowserTabs } from "./Browser";
import { Chat } from "./Chat";
import { Inspector } from "./Inspector";
import { useSession } from "./useSession";

// A session: its conversation, the composer and the bar of a running task,
// with the info card over its right side; or, once it has sub-agents, the
// background panel as a column of its own on the right, from the window's top.
export function SessionPage({ s }: { s: ListSession }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const view = useSession(s.session_id);
  const agents = view?.agents.length ?? 0;
  const running = view ? runningAgents(view).length : 0;
  const browserTabs = useBrowserTabs().filter((t) => t.session === s.session_id);
  const background = st.background && agents > 0;
  // One panel on the right at a time: the background panel when asked for, else the browser.
  const browser = st.browser && browserTabs.length > 0 && !background;
  const layout = layoutOf(st);
  const info = layout.card !== "hidden" && !background && !browser;
  // The first page the session opens brings the browser panel out.
  const hasTabs = browserTabs.length > 0;
  useEffect(() => {
    if (hasTabs) st.set({ browser: true, background: false });
  }, [hasTabs, s.session_id]);
  // `/context` answered: the card shows, its context section open.
  const asked = view?.asked?.at;
  useEffect(() => {
    if (asked === undefined) return;
    setCard(st, true);
    st.set({ contextOpen: true });
  }, [asked]);
  // The session whose title the bar is editing; another session's page shows its title.
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className={`spage ${background || browser ? "bgopen" : ""} ${background && !layout.panelFits ? "bgover" : ""}`}>
      <div className="scol">
        <GlassBar className="ctool drag">
          <SidebarToggle />
          {/* Double-click the title to edit it in place; the rest of the bar still moves the window. */}
          <div className="ctitle">
            {editing === s.session_id ? (
              <RenameField
                s={s}
                className="crename"
                end={(title) => {
                  setEditing(null);
                  if (title !== null) rename(st, s, title);
                }}
              />
            ) : (
              <h2 className="no-drag" title={displayTitle(s)} onDoubleClick={() => setEditing(s.session_id)}>
                {displayTitle(s)}
              </h2>
            )}
          </div>
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
          {/* The browser panel's button, for a session that has opened pages. */}
          {hasTabs && (
            <button
              className={`tb ${browser ? "on" : ""}`}
              title={t("browser.title")}
              aria-label={t("browser.title")}
              aria-pressed={browser}
              onClick={() => st.set(browser ? { browser: false } : { browser: true, background: false })}
            >
              <Icon name="globe" />
            </button>
          )}
          {/* A toolbar button as the sidebar's toggle is, highlighted while the info shows. */}
          <button
            className={`tb ${info ? "on" : ""}`}
            title={info ? t("page.hideInfo") : t("page.showInfo")}
            aria-label={t("page.info")}
            aria-pressed={info}
            onClick={() => setCard(st, !info)}
          >
            <Icon name="infoCard" />
          </button>
        </GlassBar>
        {/* The conversation keeps clear of the card beside it; a card over it (no room) leaves it be. */}
        <div className={`dwrap ${info && layout.card === "docked" ? "dock" : ""}`}>
          <div className="dmain">{view ? <Chat s={s} view={view} /> : <div className="empty"><span className="mini-spin" /></div>}</div>
          {view && info && <Inspector s={s} view={view} />}
        </div>
      </div>
      {view && background && <Background s={s} view={view} />}
      {browser && <BrowserPanel session={s.session_id} tabs={browserTabs} />}
    </div>
  );
}
