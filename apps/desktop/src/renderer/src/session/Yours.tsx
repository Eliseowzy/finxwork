import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { callTarget, pendingApproval, type RpcClient, type SessionView } from "@finx/client";
import type { BrowserStatus, YoursTab } from "@finx/protocol";
import type { SystemBrowser } from "../../../shared/bridge";
import { MenuButton } from "../composer/Composer";
import { Icon, Mark } from "../icons";
import { useBrowserIcon, useSystemBrowsers } from "../settings/BrowserSettings";
import { SiteIcon, siteOrigin } from "../siteIcon";
import { useStore, type Store } from "../store";

// The user's own browser in a session (browser-design §8.4.7). The agent's tabs there live in
// another window, so the session keeps a line about them: one row in the info card's 环境, only
// while it has tabs there, which goes to them. What the extension says reaches every page from
// here; the watcher below does what needs no page: following the status, and asking for the
// person when the app is not in front.

let status: BrowserStatus | null = null;
const listeners = new Set<() => void>();

function setStatus(next: BrowserStatus | null) {
  status = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** finx's word on the browsers, for this window. */
export function useBrowserStatus(): BrowserStatus | null {
  return useSyncExternalStore(subscribe, () => status);
}

/** What a session's approval hands to the person, if it does that: `browser_wait` with `user`. */
export function handoffOf(approval: { name: string; args: unknown }): string | null {
  const target = callTarget(approval.name, approval.args as never);
  return target.name === "browser_wait" && typeof target.args.user === "string" ? target.args.user : null;
}

/** "Google Chrome 156.0.8078.76" reads as "Chrome". */
function shortName(name: string): string {
  return name.replace(/ (\d+)(\.\d+)*$/, "").replace(/^(Google|Microsoft) /, "");
}

/** The user's own browser: the one connected, by its name; else the one set up; else the first here. */
export function useYourBrowser(): { name: string; browser?: SystemBrowser; refresh: () => void } {
  const { browsers, refresh } = useSystemBrowsers();
  const connected = useBrowserStatus()?.extension?.browser;
  const browser = browsers?.find((b) => connected?.startsWith(b.name)) ?? browsers?.find((b) => b.registered) ?? browsers?.[0];
  return { browser, name: shortName(connected ?? browser?.name ?? "Chrome"), refresh };
}

export async function revealYours(st: Store, browser: SystemBrowser | undefined, sessionId: string, targetId?: string) {
  await st.run(async () => {
    if (status?.extension) await st.call("browser/reveal", { session_id: sessionId, target_id: targetId });
    // The extension raises the window inside the browser; this brings the browser itself forward.
    if (browser) await window.finx?.openSystemBrowser(browser.id);
  });
}

export type YoursView = {
  name: string;
  browser?: SystemBrowser;
  tabs: YoursTab[];
  /** What the row says after the browser's name. */
  sub: string;
  /** The agent is at work there. */
  run: boolean;
  dot: "" | "w" | "c";
  revoked: boolean;
};

/** A session's tabs as last known: while the connection is down, finx knows none. */
const lastTabs = new Map<string, YoursTab[]>();

/** With no link to the browser, only asking tells whether it still runs. */
const ASK_RUNNING_MS = 3000;

export function useYours(sessionId: string, view: SessionView | undefined | null): YoursView | null {
  const { t } = useTranslation("session");
  const current = useBrowserStatus();
  const { browser, name, refresh } = useYourBrowser();
  const connected = !!current?.extension && !current.extension.problem;
  const waiting = current?.waiting?.includes(sessionId) ?? false;
  const revoked = current?.revoked?.includes(sessionId) ?? false;
  const outdated = !!current?.extension?.problem;
  const approval = view ? pendingApproval(view)?.approval : undefined;
  const handoff = approval && approval.own_browser ? handoffOf(approval) : null;
  if (connected) {
    const now = current?.tabs?.[sessionId] ?? [];
    if (now.length > 0) lastTabs.set(sessionId, now);
    else lastTabs.delete(sessionId);
  }
  const unsure = !connected && (waiting || lastTabs.has(sessionId));
  useEffect(() => {
    if (!unsure) return;
    const timer = setInterval(refresh, ASK_RUNNING_MS);
    return () => clearInterval(timer);
  }, [unsure, refresh]);
  const tabs = connected ? (current?.tabs?.[sessionId] ?? []) : (lastTabs.get(sessionId) ?? []);
  const base = { name, browser, tabs, run: false, dot: "" as const, revoked };
  if (revoked) return { ...base, sub: t("yours.revoked") };
  if (handoff !== null) return { ...base, sub: t("yours.waitingYou"), dot: "w" };
  if (!connected) {
    // Chrome gone and nothing waits for it: its tabs went with it.
    if (!waiting && browser && !browser.running) {
      lastTabs.delete(sessionId);
      return null;
    }
    if (!waiting && tabs.length === 0) return null;
    if (outdated) return { ...base, sub: t("yours.outdated") };
    const away = browser && !browser.running;
    return { ...base, sub: away ? t("yours.opening") : t("yours.reconnecting"), run: true };
  }
  if (tabs.length === 0) return null;
  return { ...base, sub: t("yours.tabs", { count: tabs.length }), run: !!view?.live && tabs.some((tab) => tab.attached) };
}

function BrowserIcon({ yours, className }: { yours: YoursView; className: string }) {
  const icon = useBrowserIcon(yours.browser?.id);
  return icon ? <img className={className} src={icon} alt="" draggable={false} /> : <Icon name="globe" />;
}

/** The row in the info card: goes to the browser; ⋯ goes to one tab, or closes them all. */
export function YoursRow({ yours, sessionId }: { yours: YoursView; sessionId: string }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const name = yours.name;
  return (
    <li className={`yr ${yours.revoked ? "revoked" : ""}`}>
      <button className="insp-row" title={t("yours.show", { name })} onClick={() => void revealYours(st, yours.browser, sessionId)}>
        <BrowserIcon yours={yours} className="yr-mark" />
        <span className="insp-where">
          <span className="insp-t">{name}</span>
          <span className={`insp-sub ${yours.run ? "shimmer" : ""}`}> · {yours.sub}</span>
        </span>
        {yours.dot && <span className={`sdot ${yours.dot}`} />}
        {!yours.revoked && <Icon name="ext" className="yr-go" />}
      </button>
      {yours.revoked ? (
        <button className="qb yr-act" onClick={() => void st.run(() => st.call("browser/allow", { session_id: sessionId }))}>{t("yours.allow")}</button>
      ) : (
        yours.tabs.length > 0 && (
          <MenuButton className="yr-more" title={t("yours.tabsMenu")} align="right" below label={<Icon name="more" />}>
            {(close) => (
              <>
                {yours.tabs.map((tab) => (
                  <button
                    key={tab.target_id}
                    className="mi"
                    role="menuitem"
                    tabIndex={-1}
                    title={tab.url}
                    onMouseMove={(e) => e.currentTarget.focus()}
                    onClick={() => {
                      close();
                      void revealYours(st, yours.browser, sessionId, tab.target_id);
                    }}
                  >
                    <SiteIcon origin={siteOrigin(tab.url)} className="yr-site" fallback={<Icon name="globe" />} />
                    <span className="yr-tab">{tab.title || tab.url}</span>
                  </button>
                ))}
                <div className="msep" role="separator" />
                <button
                  className="mi"
                  role="menuitem"
                  tabIndex={-1}
                  onMouseMove={(e) => e.currentTarget.focus()}
                  onClick={() => {
                    close();
                    void st.run(() => st.call("browser/close_tabs", { session_id: sessionId }));
                  }}
                >
                  <Icon name="x" />
                  <span>{t("yours.closeAll")}</span>
                </button>
              </>
            )}
          </MenuButton>
        )
      )}
    </li>
  );
}

/** The same in the top bar, while the info card does not show: the row moves here. */
export function YoursButton({ yours, sessionId }: { yours: YoursView; sessionId: string }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const title = `${t("yours.show", { name: yours.name })} · ${yours.sub}`;
  return (
    <button className="tb" title={title} aria-label={title} onClick={() => void revealYours(st, yours.browser, sessionId)}>
      <BrowserIcon yours={yours} className="yb-mark" />
      {yours.dot === "w" && <span className="tb-dot" />}
    </button>
  );
}

/** How long a session waits for the browser quietly: a reconnect takes seconds. */
const QUIET_MS = 10_000;

/**
 * Above the composer, when a task has waited a while for the user's own browser and only the
 * person can bring it back: the extension is off, gone, too old or still on an old program, or
 * the browser chosen is not the one connected.
 */
export function YoursWaitCard({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const current = useBrowserStatus();
  const { browser, name } = useYourBrowser();
  const problem = current?.extension?.problem ?? null;
  const waiting = (current?.waiting?.includes(sessionId) ?? false) && (!current?.extension || !!problem);
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (!waiting) return;
    const timer = setTimeout(() => setLate(true), QUIET_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  if (!waiting || !late) return null;
  const other = current?.extensions?.find((e) => !e.problem && e.instance);
  return (
    <div className="appr" role="region">
      <div className="appr-h">
        <Mark size={16} />
        <b>{t("yours.card.title", { name })}</b>
      </div>
      <div className="appr-site">
        <span>
          {problem ? t(`yours.card.outdated.${problem === "update_finx" ? "finx" : "extension"}`)
          : other ? t("yours.card.other", { other: other.account ?? shortName(other.browser ?? "Chrome") })
          : current?.refused ? t("yours.card.refused")
          : t("yours.card.desc")}
        </span>
      </div>
      <div className="appr-f">
        <button className="btn" onClick={() => void st.run(() => st.call("browser/cancel_wait", { session_id: sessionId }))}>{t("yours.card.skip", { name })}</button>
        <span className="appr-sp" />
        {other && !problem ? (
          <button className="btn primary" onClick={() => void st.run(() => st.call("browser/use_extension", { instance: other.instance! }))}>{t("yours.card.switch")}</button>
        ) : problem === "update_finx" ? (
          <button className="btn primary" onClick={() => window.finx?.checkForUpdates()}>{t("yours.card.update")}</button>
        ) : (
          browser && <button className="btn primary" onClick={() => void window.finx?.openSystemBrowser(browser.id, "extensions")}>{t("yours.card.open")}</button>
        )}
      </div>
    </div>
  );
}

/** A tab the person offered from their browser, on its way with the next message. */
export function OfferedTab() {
  const { t } = useTranslation("session");
  const st = useStore();
  const offered = st.offered;
  if (!offered) return null;
  return (
    <div className="yours-offer">
      <SiteIcon origin={siteOrigin(offered.url)} className="yr-site" fallback={<Icon name="globe" />} />
      <span className="yours-offer-t" title={offered.url}>{t("yours.offer", { title: offered.title || offered.url })}</span>
      <button className="tb" aria-label={t("yours.offerRemove")} title={t("yours.offerRemove")} onClick={() => st.set({ offered: null })}>
        <Icon name="x" />
      </button>
    </div>
  );
}

/** How often a wait for the browser tries to start it, in case it was still closing. */
const OPEN_EVERY_MS = 20_000;

function useFollowStatus(rpc: RpcClient | null, st: Store) {
  const store = useRef(st);
  store.current = st;
  useEffect(() => {
    if (!rpc) return;
    let live = true;
    const off = rpc.on("browser/changed", (s) => live && setStatus(s));
    const offRequest = rpc.on("browser/request", (request) => {
      if (!live) return;
      window.finx?.showMainWindow();
      if (request.kind === "open_session") store.current.select(request.session_id);
      else store.current.set({ offered: { target_id: request.target_id, url: request.url, title: request.title } });
    });
    rpc.request("browser/status", {}).then((s) => live && setStatus(s)).catch(() => {});
    return () => {
      live = false;
      off();
      offRequest();
      setStatus(null);
    };
  }, [rpc]);
}

/** In the main window, whichever page shows. */
export function useYoursWatcher() {
  const st = useStore();
  useFollowStatus(st.rpc, st);
  const current = useBrowserStatus();

  // A host the service refused runs another program: the launcher follows the service, and the
  // extension's next host is the right one.
  const refused = current?.refused;
  useEffect(() => {
    if (refused) void window.finx?.repairSystemBrowser();
  }, [refused]);

  // A task waits for the user's own browser: mend what leads to it, and start it behind what the
  // user is doing.
  const waitsForBrowser = (current?.waiting?.length ?? 0) > 0 && !current?.extension;
  useEffect(() => {
    if (!waitsForBrowser) return;
    void window.finx?.repairSystemBrowser().finally(() => window.finx?.openSystemBrowserQuietly());
    const timer = setInterval(() => void window.finx?.openSystemBrowserQuietly(), OPEN_EVERY_MS);
    return () => clearInterval(timer);
  }, [waitsForBrowser]);
}
