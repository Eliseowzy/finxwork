import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserTab, BrowserTabCommand } from "../../../shared/bridge";
import { Icon } from "../icons";
import { useCovered } from "../overlays";

// The embedded browser's panel (browser-design §8.3.4), drawn as a browser: the session's
// tabs and a new-tab button on top, then back, forward, reload and the address, and below
// them the room where the main process lays the tab's own view. The page itself never draws
// a website: it only says where the room is. What the person does here takes the tab over
// from the agent, whose next call finds the page changed.

/** The embedded browser's tabs, as the main process has them. */
export function useBrowserTabs(): BrowserTab[] {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  useEffect(() => {
    // The web build has no main process, and so no embedded browser.
    const finx = window.finx;
    if (!finx) return;
    let live = true;
    void finx.browserTabs().then((t) => live && setTabs(t));
    const off = finx.onBrowserTabs(setTabs);
    return () => {
      live = false;
      off();
    };
  }, []);
  return tabs;
}

/** A blank page: the address field shows empty, the tab "New tab". */
const blank = (url: string) => url === "" || url === "about:blank";

const command = (t: BrowserTab | undefined, c: BrowserTabCommand) => t && window.finx?.browserTabCommand(t.targetId, c);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The panel's width the person dragged it to, kept for later. */
const widthKey = "finxwork.browserPanelWidth";
const minWidth = 360;
/** What the conversation keeps beside the panel at least (layout.ts). */
const conversationRoom = 560;

function savedWidth(): number | null {
  const n = Number(localStorage.getItem(widthKey));
  return Number.isFinite(n) && n >= minWidth ? n : null;
}

export function BrowserPanel({ session, tabs }: { session: string; tabs: BrowserTab[] }) {
  const { t } = useTranslation("session");
  const room = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const current = tabs.find((x) => x.shown) ?? tabs[tabs.length - 1];
  const [width, setWidth] = useState<number | null>(savedWidth);
  /** What the person is typing in the address field; null shows the tab's address. */
  const [draft, setDraft] = useState<string | null>(null);
  const address = useRef<HTMLInputElement>(null);
  // A new blank tab waits for an address.
  const currentId = current?.targetId;
  const currentBlank = current ? blank(current.url) : false;
  useEffect(() => {
    setDraft(null);
    if (currentBlank) address.current?.focus();
  }, [currentId]);
  const [resizing, setResizing] = useState(false);
  // A dialog, the search palette or the settings' dim is over the window: the tab steps aside.
  const covered = useCovered();

  /** The widest the panel may be: the conversation keeps its room. */
  const maxWidth = () => {
    const right = panel.current?.getBoundingClientRect().right ?? window.innerWidth;
    const left = panel.current?.parentElement?.getBoundingClientRect().left ?? 0;
    return Math.max(minWidth, right - left - conversationRoom);
  };
  const keep = (w: number) => {
    const next = Math.round(Math.min(maxWidth(), Math.max(minWidth, w)));
    setWidth(next);
    localStorage.setItem(widthKey, String(next));
  };
  // The arrow keys on the edge: left widens, right narrows.
  const resizeByKey = (e: React.KeyboardEvent) => {
    const now = panel.current?.getBoundingClientRect().width ?? minWidth;
    if (e.key === "ArrowLeft") keep(now + 24);
    else if (e.key === "ArrowRight") keep(now - 24);
    else return;
    e.preventDefault();
  };

  // Dragging the left edge. The tab's view sits above the page and would take the pointer,
  // so it steps aside (rect null) until the drag ends.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const right = panel.current?.getBoundingClientRect().right ?? window.innerWidth;
    const max = maxWidth();
    window.finx?.setBrowserPanel({ session, rect: null });
    setResizing(true);
    const move = (ev: PointerEvent) => setWidth(Math.round(Math.min(max, Math.max(minWidth, right - ev.clientX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResizing(false);
      setWidth((w) => {
        if (w !== null) localStorage.setItem(widthKey, String(w));
        return w;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Where the tab's view goes, in window coordinates; reported again as it moves or resizes.
  useLayoutEffect(() => {
    const el = room.current;
    const finx = window.finx;
    if (!el || !finx || resizing || covered) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      finx.setBrowserPanel({ session, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      finx.setBrowserPanel({ session: null, rect: null });
    };
  }, [session, resizing, covered]);

  return (
    <aside
      ref={panel}
      className={`bgp brp ${width !== null ? "sized" : ""} ${resizing ? "resizing" : ""}`}
      style={width !== null ? ({ "--brp-w": `${width}px` } as React.CSSProperties) : undefined}
      aria-label={t("browser.title")}
    >
      <div className="brp-grip no-drag" role="separator" aria-orientation="vertical" aria-label={t("browser.resize")} aria-valuenow={width ?? undefined} tabIndex={0} onPointerDown={startResize} onKeyDown={resizeByKey} />
      <div className="brp-strip drag">
        <div className="brp-tabs" role="tablist">
          {tabs.map((x) => {
            const on = x.targetId === current?.targetId;
            // A page without a title of its own shows its URL as one: name it by its host.
            const untitled = !x.title || x.title === x.url || blank(x.title);
            const name = blank(x.url) ? t("browser.newTab") : untitled ? hostOf(x.url) || x.url : x.title;
            return (
              <div key={x.targetId} role="tab" aria-selected={on} className={`brp-tab no-drag ${on ? "on" : ""}`} title={x.url || name} onClick={() => window.finx?.showBrowserTab(x.targetId)}>
                {x.loading && <span className="mini-spin" aria-hidden="true" />}
                <span className="brp-tab-t">{name}</span>
                <button
                  className="brp-tab-x"
                  aria-label={t("browser.closeTab", { name })}
                  title={t("browser.closeTab", { name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    command(x, { command: "close" });
                  }}
                >
                  <Icon name="x" />
                </button>
              </div>
            );
          })}
        </div>
        <button className="tb no-drag" aria-label={t("browser.newTab")} title={t("browser.newTab")} onClick={() => command(current, { command: "new" })}>
          <Icon name="plus" />
        </button>
      </div>
      <div className="brp-bar">
        <button className="tb" aria-label={t("browser.back")} title={t("browser.back")} disabled={!current?.canGoBack} onClick={() => command(current, { command: "back" })}>
          <Icon name="arrowLeft" />
        </button>
        <button className="tb" aria-label={t("browser.forward")} title={t("browser.forward")} disabled={!current?.canGoForward} onClick={() => command(current, { command: "forward" })}>
          <Icon name="arrowRight" />
        </button>
        {current?.loading ? (
          <button className="tb" aria-label={t("browser.stop")} title={t("browser.stop")} onClick={() => command(current, { command: "stop" })}>
            <Icon name="x" />
          </button>
        ) : (
          <button className="tb" aria-label={t("browser.reload")} title={t("browser.reload")} disabled={!current} onClick={() => command(current, { command: "reload" })}>
            <Icon name="retry" />
          </button>
        )}
        <form
          className="brp-addr"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft !== null && draft.trim()) command(current, { command: "go", url: draft });
            setDraft(null);
            address.current?.blur();
          }}
        >
          <input
            ref={address}
            className="brp-url"
            aria-label={t("browser.address")}
            placeholder={t("browser.typeUrl")}
            spellCheck={false}
            value={draft ?? (current && !blank(current.url) ? current.url : "")}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(null);
                e.currentTarget.blur();
              }
            }}
          />
        </form>
      </div>
      <div className="brp-view" ref={room} />
    </aside>
  );
}
