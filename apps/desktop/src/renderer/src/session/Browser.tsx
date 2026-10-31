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

export function BrowserPanel({ session, tabs }: { session: string; tabs: BrowserTab[] }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const room = useRef<HTMLDivElement>(null);
  const current = tabs.find((x) => x.shown) ?? tabs[tabs.length - 1];

  // Where the tab's view goes, in window coordinates; reported again as it moves or resizes.
  useLayoutEffect(() => {
    const el = room.current;
    const finx = window.finx;
    if (!el || !finx) return;
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
  }, [session]);

  return (
    <aside className="bgp brp" aria-label={t("browser.title")}>
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
