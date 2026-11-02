import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserStatus, ExtensionProblem } from "@finx/protocol";
import type { SystemBrowser, SystemBrowserId } from "../../../shared/bridge";
import { Dialog } from "../components";
import { Icon } from "../icons";
import { errorText, useStore } from "../store";
import { BuiltInBrowser } from "./BuiltInBrowser";

// Settings › Browser: what the agent's two browsers share (connectors-entry-design §8). The
// built-in browser's switch; the user's own browser, whose row says whether it is connected and
// in use and offers the one thing to do ("Connect" walks through the setup: pick the browser,
// the app registers finx, the user adds the extension, and the app waits for it to connect,
// then turns it on); the site permissions of both; scripts; and the address bar of the
// browser panel.

/** The extension's page in the Chrome Web Store, once it is published; until then the guide loads it from its folder. */
const STORE_URL = "";

/** `[browser]` as this page reads it. `builtin` and `extension` are null when not set: the built-in browser is then on in this app, the user's own browser not connected yet. */
export type BrowserConfig = {
  builtin: boolean | null;
  extension: boolean | null;
  /** The old way of choosing the user's own browser, rewritten on the next write. */
  legacyBackend: boolean;
  sites: [string, string][];
  scripts: boolean;
};

/** finx's word on the browsers (browser/status, then browser/changed), and the [browser] settings. */
export function useBrowserState() {
  const st = useStore();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [config, setConfig] = useState<BrowserConfig | null>(null);
  const readConfig = useCallback(async () => {
    if (!st.rpc) return;
    const r = await st.rpc.request("config/read", {});
    const browser = ((r.config as Record<string, unknown>)?.browser ?? {}) as Record<string, unknown>;
    const legacyBackend = browser.backend === "extension";
    const sites = Object.entries((browser.sites ?? {}) as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
    setConfig({
      builtin: typeof browser.enabled === "boolean" ? browser.enabled : null,
      extension: typeof browser.extension === "boolean" ? browser.extension : legacyBackend ? true : null,
      legacyBackend,
      // "All sites" first, then by origin.
      sites: sites.sort(([a], [b]) => (a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b))),
      scripts: browser.script_enabled === true,
    });
  }, [st.rpc]);
  useEffect(() => {
    const rpc = st.rpc;
    if (!rpc) return;
    let live = true;
    const off = rpc.on("browser/changed", (s) => live && setStatus(s));
    rpc.request("browser/status", {}).then((s) => live && setStatus(s)).catch(() => {});
    void readConfig().catch(() => {});
    const offConfig = rpc.on("config/changed", () => void readConfig().catch(() => {}));
    return () => {
      live = false;
      off();
      offConfig();
    };
  }, [st.rpc, readConfig]);
  /** Edits of `[browser]` in the user's own file, then the page reads it again; finx's answer says whether another file overrides them. */
  const write = useCallback(
    async (edits: { key_path: string; value: unknown }[]) => {
      const r = await st.call("config/write", { layer: "user", edits });
      await readConfig();
      return r;
    },
    [st, readConfig],
  );
  /** The user's own browser on or off: every conversation from its next step (connectors-entry-design §5). */
  const use = useCallback(
    (on: boolean) =>
      write([
        { key_path: "browser.extension", value: on },
        // From before the user's own browser had its own switch.
        ...(config?.legacyBackend ? [{ key_path: "browser.backend", value: null }] : []),
      ]),
    [write, config?.legacyBackend],
  );
  return { status, config, use, write };
}

/** The browsers here, asked again whenever the window comes back to the front (the user may have opened or installed one). */
export function useSystemBrowsers() {
  const [browsers, setBrowsers] = useState<SystemBrowser[] | null>(null);
  const refresh = useCallback(() => void window.finx?.systemBrowsers().then(setBrowsers), []);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  return { browsers, refresh };
}

export function BrowserSettings() {
  const { t } = useTranslation("settings");
  const st = useStore();
  const { status, config, use, write } = useBrowserState();
  const { browsers, refresh } = useSystemBrowsers();
  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // An extension that cannot be used (it or finx is too old, D-219) is not connected, but says what to update.
  const problem = status?.extension?.problem ?? null;
  const connected = problem ? null : (status?.extension ?? null);
  const inUse = config?.extension === true;
  const registered = browsers?.filter((b) => b.registered) ?? [];
  // The connected one, by the name it gave; else the one it was set up for; else the first here.
  const mine =
    browsers?.find((b) => connected?.browser?.startsWith(b.name)) ?? registered[0] ?? browsers?.[0];

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  let state: "none" | "on" | "ready" | "lost" | "off" | "outdated";
  if (problem) state = "outdated";
  else if (browsers && browsers.length === 0 && !connected) state = "none";
  else if (connected) state = inUse ? "on" : "ready";
  else state = inUse ? "lost" : "off";

  // "Google Chrome 156.0.8078.76" reads as "Google Chrome 156".
  const name = connected?.browser?.replace(/ (\d+)(\.\d+)+$/, " $1") ?? mine?.name ?? "Chrome";
  const desc =
    state === "none" ? t("browser.none")
    : state === "on" ? t("browser.on")
    : state === "ready" ? t("browser.ready")
    : state === "lost" ? (mine && !mine.running ? t("browser.closed", { name: mine.name }) : t("browser.lost"))
    : state === "outdated" ? t(`browser.outdated.${problem === "update_finx" ? "finx" : "extension"}`, { name: mine?.name ?? "Chrome" })
    : t("browser.off");
  const badge =
    state === "on" ? <span className="badge ok">{t("browser.badge.on")}</span>
    : state === "ready" ? <span className="badge acc">{t("browser.badge.ready")}</span>
    : state === "lost" ? <span className="badge warn">{t("browser.badge.lost")}</span>
    : state === "outdated" ? <span className="badge warn">{t("browser.badge.outdated")}</span>
    : <span className="badge">{t("browser.badge.off")}</span>;

  return (
    <div className="form browser-set">
      <section>
        <h3 className="fhead">{t("browser.agent")}</h3>
        <div className="fgroup">
          <div className="frow">
            <div className="ft">
              <div className="fn">{t("browser.builtin")}</div>
              <div className="fdesc">{t("browser.builtinDesc")}</div>
            </div>
            {/* Not set: on in this app (connectors-entry-design §9.1). */}
            <Switch
              on={config?.builtin ?? true}
              label={t("browser.builtin")}
              disabled={!config || busy}
              onChange={(on) => void act(() => write([{ key_path: "browser.enabled", value: on }]))}
            />
          </div>
          <div className="frow mrow">
            <BrowserMark id={mine?.id} />
            <div className="ft">
              <div className="fn">
                {state === "on" || state === "ready" ? name : t("browser.title")} {badge}
              </div>
              <div className={`fdesc ${state === "lost" || state === "outdated" ? "warn" : ""}`}>{desc}</div>
            </div>
            {state === "none" && (
              <button className="btn" onClick={() => window.finx?.openExternal("https://www.google.com/chrome/")}>{t("browser.getChrome")}</button>
            )}
            {state === "off" && (
              <button className="btn primary" disabled={!st.rpc} onClick={() => setGuide(true)}>{t("browser.connect")}</button>
            )}
            {state === "ready" && (
              <button className="btn primary" disabled={busy} onClick={() => void act(() => use(true))}>{t("browser.start")}</button>
            )}
            {state === "on" && (
              <button className="btn" disabled={busy} onClick={() => void act(() => use(false))}>{t("browser.stop")}</button>
            )}
            {state === "outdated" && problem === "update_extension" && mine && (
              <button className="btn" onClick={() => void window.finx?.openSystemBrowser(mine.id, "extensions")}>{t("browser.guide.openExtensions")}</button>
            )}
            {state === "outdated" && problem === "update_finx" && (
              <button className="btn primary" onClick={() => window.finx?.checkForUpdates()}>{t("browser.checkUpdates")}</button>
            )}
            {state === "lost" && (
              <>
                {mine && !mine.running && (
                  <button className="btn primary" onClick={() => void window.finx?.openSystemBrowser(mine.id).then(refresh)}>{t("browser.open", { name: mine.name })}</button>
                )}
                <button className="btn" onClick={() => setGuide(true)}>{t("browser.reconnect")}</button>
              </>
            )}
          </div>
        </div>
        {error && <p className="mrow-err">{error}</p>}
        <p className="set-note">{t("browser.note")}</p>
      </section>
      {config && <SitePermissions sites={config.sites} write={(edits) => act(() => write(edits))} />}
      <section>
        <h3 className="fhead">{t("browser.scripts")}</h3>
        <div className="fgroup">
          <div className="frow">
            <div className="ft">
              <div className="fn">{t("browser.scriptsOn")}</div>
              <div className="fdesc">{t("browser.scriptsDesc")}</div>
            </div>
            <Switch
              on={!!config?.scripts}
              label={t("browser.scriptsOn")}
              disabled={!config || busy}
              onChange={(on) => void act(() => write([{ key_path: "browser.script_enabled", value: on }]))}
            />
          </div>
        </div>
      </section>
      <BuiltInBrowser />
      {guide && browsers && (
        <Guide
          browsers={browsers}
          connected={!!connected}
          problem={problem}
          onConnected={() => use(true)}
          refresh={refresh}
          onClose={() => {
            setGuide(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** The browser's own icon, read from the installed app; a globe while there is none. */
export function BrowserMark({ id }: { id?: SystemBrowserId }) {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setIcon(null);
    if (id) void window.finx?.systemBrowserIcon(id).then((src) => live && setIcon(src));
    return () => {
      live = false;
    };
  }, [id]);
  return icon ? <img className="mtile browser-mark" src={icon} alt="" draggable={false} /> : <span className="mtile"><Icon name="globe" /></span>;
}

type Step = "pick" | "prepare" | "install" | "wait" | "done";

/** The setup, one step at a time. Only adding the extension needs the user; the rest the app does. */
/** How long the extension gets to connect before the guide says what to check. */
const WAIT_SECONDS = 5;

export function Guide({
  browsers,
  connected,
  problem,
  onConnected,
  refresh,
  onClose,
}: {
  browsers: SystemBrowser[];
  connected: boolean;
  problem: ExtensionProblem | null;
  onConnected: () => Promise<unknown>;
  refresh: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const [picked, setBrowser] = useState<SystemBrowser>(() => browsers.find((b) => b.running) ?? browsers[0]);
  // The picked browser as last asked: whether it is open changes while the guide is up.
  const browser = browsers.find((b) => b.id === picked.id) ?? picked;
  const [step, setStep] = useState<Step>(browsers.length > 1 ? "pick" : "prepare");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Seconds left before saying what to check, counted down on screen so the wait has an end.
  const [left, setLeft] = useState(WAIT_SECONDS);
  const slow = left === 0;

  // Registering finx: done by the app, shown as a step so a failure has somewhere to be said.
  useEffect(() => {
    if (step !== "prepare") return;
    let live = true;
    setError("");
    void window.finx?.setUpSystemBrowser().then((r) => {
      if (!live) return;
      if (r.ok) setStep(connected ? "wait" : "install");
      else setError(r.message);
    });
    return () => {
      live = false;
    };
  }, [step, connected, attempt]);

  // Waiting: finx says when the extension connects; then it is turned on.
  useEffect(() => {
    if (step !== "wait" || !connected) return;
    let live = true;
    onConnected()
      .then(() => live && setStep("done"))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [step, connected, onConnected]);

  // While waiting, ask again and again whether the browser is open: the extension connects only once it is.
  useEffect(() => {
    if (step !== "wait" || connected) return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [step, connected, refresh]);
  useEffect(() => {
    setLeft(WAIT_SECONDS);
    if (step !== "wait" || connected || !browser.running) return;
    const timer = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(timer);
  }, [step, connected, browser.running]);

  const order = ["prepare", "install", "wait"] as const;
  const index = step === "done" ? order.length : Math.max(0, (order as readonly Step[]).indexOf(step));

  return (
    <Dialog label={t("browser.guide.title")} width={520} className="browser-guide" onClose={onClose}>
      <div className="provider-dialog-top">
        <span>{t("browser.guide.title")}</span>
        <button className="provider-icon-button" aria-label={t("models.close")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="bg-body">
        {step !== "pick" && (
          <ol className="bg-steps" aria-label={t("browser.guide.title")}>
            {order.map((s, i) => (
              <li key={s} className={i < index ? "done" : i === index ? "now" : ""}>
                <span className="bg-num">{i < index ? <Icon name="check" /> : i + 1}</span>
                {t(`browser.guide.steps.${s}`)}
              </li>
            ))}
          </ol>
        )}

        {step === "pick" && (
          <>
            <p className="bg-lead">{t("browser.guide.pick")}</p>
            <div className="bg-pick" role="radiogroup">
              {browsers.map((b) => (
                <button key={b.id} role="radio" aria-checked={b.id === browser.id} className={b.id === browser.id ? "on" : ""} onClick={() => setBrowser(b)}>
                  <BrowserMark id={b.id} />
                  {b.name}
                </button>
              ))}
            </div>
            <div className="bg-actions">
              <button className="btn primary" onClick={() => setStep("prepare")}>{t("browser.guide.next")}</button>
            </div>
          </>
        )}

        {step === "prepare" && (
          <div className="bg-status">
            {error ? (
              <>
                <p className="mrow-err">{t("browser.guide.prepareFailed", { message: error })}</p>
                <div className="bg-actions">
                  <button className="btn" onClick={() => setAttempt((n) => n + 1)}>{t("browser.guide.retry")}</button>
                </div>
              </>
            ) : (
              <p className="bg-lead"><span className="mini-spin" />{t("browser.guide.preparing")}</p>
            )}
          </div>
        )}

        {step === "install" &&
          (STORE_URL ? (
            <>
              <p className="bg-lead">{t("browser.guide.store", { name: browser.name })}</p>
              <div className="bg-actions">
                <button className="btn primary" onClick={() => { window.finx?.openExternal(STORE_URL); setStep("wait"); }}>{t("browser.guide.addToBrowser", { name: browser.name })}</button>
              </div>
            </>
          ) : (
            <>
              <p className="bg-lead">{t("browser.guide.install", { name: browser.name })}</p>
              <ol className="bg-howto">
                <li>
                  <span>{t("browser.guide.howto.open", { name: browser.name })}</span>
                  <button className="btn" onClick={() => void window.finx?.openSystemBrowser(browser.id, "extensions")}>{t("browser.guide.openExtensions")}</button>
                </li>
                <li><span>{t("browser.guide.howto.developer")}</span></li>
                <li>
                  <span>{t("browser.guide.howto.drag")}</span>
                  <button className="btn" onClick={() => window.finx?.revealBrowserExtension()}>{t("browser.guide.showFolder")}</button>
                </li>
              </ol>
              <p className="set-note">{t("browser.guide.already")}</p>
              <div className="bg-actions">
                <button className="btn primary" onClick={() => setStep("wait")}>{t("browser.guide.added")}</button>
              </div>
            </>
          ))}

        {step === "wait" && (
          <div className="bg-status">
            {error ? (
              <p className="mrow-err">{error}</p>
            ) : problem ? (
              <p className="mrow-err">{t(`browser.outdated.${problem === "update_finx" ? "finx" : "extension"}`, { name: browser.name })}</p>
            ) : !browser.running ? (
              <p className="bg-lead">{t("browser.guide.notOpen", { name: browser.name })}</p>
            ) : (
              <p className="bg-lead"><span className="mini-spin" />{t("browser.guide.waiting", { name: browser.name })}{!slow && <span className="bg-count">{t("browser.guide.countdown", { count: left })}</span>}</p>
            )}
            {!error && !problem && browser.running && slow && <p className="set-note">{t("browser.guide.waitHint", { name: browser.name })}</p>}
            <div className="bg-actions">
              <button className="btn" onClick={() => setStep("install")}>{t("browser.guide.back")}</button>
              {!error && !browser.running && (
                <button className="btn primary" onClick={() => void window.finx?.openSystemBrowser(browser.id).then(refresh)}>{t("browser.open", { name: browser.name })}</button>
              )}
              {!error && !problem && browser.running && slow && (
                <button className="btn" onClick={() => void window.finx?.openSystemBrowser(browser.id, "extensions")}>{t("browser.guide.openExtensions")}</button>
              )}
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="bg-status">
            <p className="bg-lead ok"><Icon name="check" />{t("browser.guide.done", { name: browser.name })}</p>
            <p className="set-note">{t("browser.guide.doneHint")}</p>
            <div className="bg-actions">
              <button className="btn primary" onClick={onClose}>{t("browser.guide.finish")}</button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return <button className={`sw ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}

const LEVELS = ["act", "navigate", "deny"] as const;

/** A site as `browser.sites` keys it: an origin is quoted, as it has dots and a colon. */
const siteKey = (origin: string) => `browser.sites.${JSON.stringify(origin)}`;

/**
 * The sites of both browsers (browser-design §7.3, D-221): each with its level, which can be
 * changed or removed. "All sites" comes first; removing it takes back what "allow all sites"
 * gave. The agent's "always allow" adds sites here.
 */
function SitePermissions({ sites, write }: { sites: [string, string][]; write: (edits: { key_path: string; value: unknown }[]) => Promise<unknown> }) {
  const { t } = useTranslation("settings");
  return (
    <section>
      <h3 className="fhead">{t("browser.sites")}</h3>
      <div className="fgroup">
        {sites.length === 0 && (
          <div className="frow">
            <div className="ft">
              <div className="fdesc">{t("browser.sitesEmpty")}</div>
            </div>
          </div>
        )}
        {sites.map(([origin, level]) => {
          const name = origin === "*" ? t("browser.allSites") : origin;
          return (
            <div className="frow site-row" key={origin}>
              <div className="ft">
                <div className={`fn ${origin === "*" ? "" : "mono"}`}>{name}</div>
                {origin === "*" && <div className="fdesc">{t("browser.allSitesDesc")}</div>}
              </div>
              <select
                className="psel"
                aria-label={t("browser.siteLevel", { site: name })}
                value={level}
                onChange={(e) => void write([{ key_path: siteKey(origin), value: e.target.value }])}
              >
                {/* "All sites" is never refused as a whole: that is the domain lists' job. */}
                {LEVELS.filter((l) => origin !== "*" || l !== "deny").map((l) => (
                  <option key={l} value={l}>
                    {t(`browser.level.${l}`)}
                  </option>
                ))}
              </select>
              <button className="btn" aria-label={t("browser.removeSite", { site: name })} onClick={() => void write([{ key_path: siteKey(origin), value: null }])}>
                {t("browser.remove")}
              </button>
            </div>
          );
        })}
      </div>
      <p className="set-note">{t("browser.sitesNote")}</p>
    </section>
  );
}
