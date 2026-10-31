import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserTab } from "../../../shared/bridge";
import { Icon } from "../icons";
import { useStore } from "../store";

// The embedded browser's panel (browser-design §8.3.4): the session's tabs, the address of
// the one shown, and below them the room where the main process lays the tab's own view.
// The page itself never draws a website: it only says where the room is.

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

const label = (t: BrowserTab) => t.title || hostOf(t.url) || t.url || "about:blank";

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
  const st = useStore();
  const room = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const current = tabs.find((x) => x.shown) ?? tabs[tabs.length - 1];
  const [width, setWidth] = useState<number | null>(savedWidth);
  const [resizing, setResizing] = useState(false);

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
    if (!el || !finx || resizing) return;
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
  }, [session, resizing]);

  return (
    <aside
      ref={panel}
      className={`bgp brp ${width !== null ? "sized" : ""} ${resizing ? "resizing" : ""}`}
      style={width !== null ? ({ "--brp-w": `${width}px` } as React.CSSProperties) : undefined}
      aria-label={t("browser.title")}
    >
      <div className="brp-grip no-drag" role="separator" aria-orientation="vertical" aria-label={t("browser.resize")} aria-valuenow={width ?? undefined} tabIndex={0} onPointerDown={startResize} onKeyDown={resizeByKey} />
      <div className="bgp-top drag">
        <h3>{t("browser.title")}</h3>
        <button className="tb" aria-label={t("browser.close")} title={t("browser.close")} onClick={() => st.set({ browser: false })}>
          <Icon name="x" />
        </button>
      </div>
      <div className="brp-tabs no-drag" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.targetId}
            role="tab"
            aria-selected={x.targetId === current?.targetId}
            className={`brp-tab ${x.targetId === current?.targetId ? "on" : ""}`}
            title={x.url}
            onClick={() => window.finx?.showBrowserTab(x.targetId)}
          >
            {label(x)}
          </button>
        ))}
      </div>
      <div className="brp-url sel-text" title={current?.url}>
        <Icon name="globe" />
        <span>{current?.url || "about:blank"}</span>
      </div>
      <div className="brp-view" ref={room} />
    </aside>
  );
}
