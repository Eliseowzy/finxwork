import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserStatus, ExtensionProblem } from "@finx/protocol";
import type { SystemBrowser, SystemBrowserId } from "../../../shared/bridge";
import { Dialog } from "../components";
import { Icon } from "../icons";
import { SiteIcon } from "../siteIcon";
import { errorText, useStore } from "../store";
import { BuiltInBrowser } from "./BuiltInBrowser";

// Settings › Browser (browser-design §10.1): whether FinxWork controls browsers, and which one a
// page opens in by default; the user's own browser, whose row says whether it is connected and
// offers the one thing to do ("Connect" walks through the setup: pick the browser, the app
// registers finx, the user adds the extension, and the app waits for it to connect, then turns
// it on); the site permissions of both; and the built-in browser's own search, for the browser
// panel. Page scripts are on and not shown (each still asks before it runs).

/** The extension's page in the Chrome Web Store, once it is published; until then the guide loads it from its folder. */
const STORE_URL = "";

/** `[browser]` as this page reads it. `enabled` and `extension` are null when not set: browser control is then on in this app, the user's own browser not connected yet. */
export type BrowserConfig = {
  enabled: boolean | null;
  extension: boolean | null;
  /** Where a page opens when the agent names no browser. */
  default: "builtin" | "yours";
  /** The old way of choosing the user's own browser, rewritten on the next write. */
  legacyBackend: boolean;
  sites: [string, string][];
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
      enabled: typeof browser.enabled === "boolean" ? browser.enabled : null,
      extension: typeof browser.extension === "boolean" ? browser.extension : legacyBackend ? true : null,
      default: browser.default === "yours" ? "yours" : "builtin",
      legacyBackend,
      // "All sites" first, then by origin.
      sites: sites.sort(([a], [b]) => (a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b))),
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

/** The browser's own icon, read from the installed app. */
export function useBrowserIcon(id?: SystemBrowserId): string | null {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setIcon(null);
    if (id) void window.finx?.systemBrowserIcon(id).then((src) => live && setIcon(src));
    return () => {
      live = false;
    };
  }, [id]);
  return icon;
}

/** How long a refused host gets to exit and come back as the current program. */
const REFUSED_STUCK_MS = 10_000;

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
  const refused = status?.refused;
  // A host that exits on refusal is gone in moments. One that stays runs code from before it could.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    setStuck(false);
    if (!refused) return;
    const timer = setTimeout(() => setStuck(true), REFUSED_STUCK_MS);
    return () => clearTimeout(timer);
  }, [!!refused]);
  // Several browsers or profiles have the extension: the user says which the agent uses.
  const several = status?.extensions ?? [];
  // The manifest is another FinxWork's: this one's extension would not reach it.
  const elsewhere = !connected && browsers?.some((b) => b.manifest === "other");
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
    : state === "lost" ? (mine && !mine.running ? t("browser.closed", { name: mine.name }) : refused ? t(stuck ? "browser.refusedStuck" : "browser.refused") : elsewhere ? t("browser.elsewhere") : t("browser.lost", { name: mine?.name ?? "Chrome" }))
    : state === "outdated" ? t(`browser.outdated.${problem === "update_finx" ? "finx" : "extension"}`, { name: mine?.name ?? "Chrome" })
    : t("browser.off");
  const badge =
    state === "on" ? <span className="badge ok">{t("browser.badge.on")}</span>
    : state === "ready" ? <span className="badge acc">{t("browser.badge.ready")}</span>
    : state === "lost" ? <span className="badge warn">{t("browser.badge.lost")}</span>
    : state === "outdated" ? <span className="badge warn">{t("browser.badge.outdated")}</span>
    : <span className="badge">{t("browser.badge.off")}</span>;

  // Browser control: not set, on in this app.
  const control = config?.enabled !== false;
  // The user's browser can be the default once it is connected for the agent.
  const yoursName = inUse ? (connected?.browser?.replace(/ (\d+)(\.\d+)+$/, "") ?? mine?.name ?? "Chrome") : null;
  const defaultBrowser = config?.default === "yours" && yoursName ? "yours" : "builtin";

  return (
    <div className="form browser-set">
      <section>
        <div className="fgroup">
          <div className="frow">
            <div className="ft">
              <div className="fn">{t("browser.control")}</div>
              <div className="fdesc">{t(control ? "browser.controlOn" : "browser.controlOff")}</div>
            </div>
            <Switch on={control} label={t("browser.control")} disabled={!config || busy} onChange={(on) => void act(() => write([{ key_path: "browser.enabled", value: on }]))} />
          </div>
          {/* Always there; while browser control is off, it cannot be changed. */}
          <div className={`frow default-browser ${control ? "" : "off"}`}>
            <div className="ft">
              <div className="fn">{t("browser.default")}</div>
              <div className="fdesc">{t("browser.defaultDesc")}</div>
            </div>
            <select
              className="psel"
              aria-label={t("browser.default")}
              value={defaultBrowser}
              disabled={!config || busy || !control}
              onChange={(e) => void act(() => write([{ key_path: "browser.default", value: e.target.value }]))}
            >
              <option value="builtin">{t("browser.builtin")}</option>
              {yoursName && <option value="yours">{t("browser.yoursOption", { name: yoursName })}</option>}
            </select>
          </div>
        </div>
      </section>

      <section>
        <h3 className="fhead">{t("browser.title")}</h3>
        <div className="fgroup">
          <div className="frow mrow yours-row">
            <BrowserMark id={mine?.id} />
            <div className="ft">
              <div className="fn">
                {state === "on" || state === "ready" ? name : t("browser.connectTitle")} {state !== "none" && state !== "off" && badge}
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
              <button className="btn primary" disabled={busy} onClick={() => void act(() => use(true))}>{t("browser.connect")}</button>
            )}
            {state === "on" && (
              <button className="btn" disabled={busy} onClick={() => void act(() => use(false))}>{t("browser.disconnect")}</button>
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
                {mine && mine.running && !elsewhere && (
                  <button className="btn primary" onClick={() => void window.finx?.openSystemBrowser(mine.id, "extensions")}>{t("browser.guide.openExtensions")}</button>
                )}
                <button className="btn" onClick={() => setGuide(true)}>{elsewhere ? t("browser.takeOver") : t("browser.reconnect")}</button>
              </>
            )}
          </div>
        </div>
        {/* It lists one only when that one is not in use: the browser chosen is away. */}
        {several.length > 0 && (
          <div className="fgroup" style={{ marginTop: "var(--sp-1)" }}>
            {several.map((e) => (
              <div className="frow mrow ext-row" key={e.instance ?? e.browser}>
                <div className="ft">
                  <div className="fn">
                    {e.browser?.replace(/ (\d+)(\.\d+)+$/, " $1") ?? "Chrome"}
                    {e.account && <span className="mi-acct"> · {e.account}</span>}
                  </div>
                </div>
                {e.in_use ? (
                  <span className="badge ok">{t("browser.badge.on")}</span>
                ) : (
                  <button className="btn" disabled={!e.instance || busy} onClick={() => void act(() => st.call("browser/use_extension", { instance: e.instance! }))}>{t("browser.useThis")}</button>
                )}
              </div>
            ))}
          </div>
        )}
        {error && <p className="mrow-err">{error}</p>}
        {state !== "none" && <Diagnosis status={status} />}
      </section>
      {config && <SitePermissions sites={config.sites} write={(edits) => act(() => write(edits))} />}
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

/** Each link from the browser to finx's service, to read or to pass on when something does not connect. */
function Diagnosis({ status }: { status: BrowserStatus | null }) {
  const { t } = useTranslation("settings");
  const st = useStore();
  const [text, setText] = useState<string | null>(null);
  const read = async () => {
    const d = await window.finx?.diagnoseSystemBrowser();
    if (!d) return;
    setText(
      [
        `FinxWork ${d.app}`,
        `service: ${d.service ?? "-"}`,
        `host script: ${d.launcher}`,
        `host program: ${d.program ?? "-"}${d.program && !d.programExists ? " (missing)" : ""}`,
        `extension folder: ${d.extensionFolder} (build ${d.extensionBuild ?? "-"})`,
        ...d.browsers.map((b) => `${b.name}: ${b.running ? "running" : "not running"}, manifest ${b.manifest}`),
        `extension: ${status?.extension ? `${status.extension.browser ?? "?"}, version ${status.extension.extension_version ?? "?"}${status.extension.problem ? `, ${status.extension.problem}` : ""}` : "not connected"}`,
        ...(status?.refused ? [`refused: ${status.refused}`] : []),
      ].join("\n"),
    );
  };
  if (text === null) {
    return (
      <div className="browser-diag-bar">
        <button className="qb" onClick={() => void read()}>{t("browser.diagnose")}</button>
      </div>
    );
  }
  return (
    <>
      <pre className="browser-diag">{text}</pre>
      <div className="browser-diag-bar">
        <button className="qb" onClick={() => void navigator.clipboard.writeText(text).then(() => st.show(t("browser.diagnosisCopied")))}>{t("browser.copyDiagnosis")}</button>
        <button className="qb" onClick={() => setText(null)}>{t("browser.hideDiagnosis")}</button>
      </div>
    </>
  );
}

/** The browser's own icon, read from the installed app; a globe while there is none. */
export function BrowserMark({ id }: { id?: SystemBrowserId }) {
  const icon = useBrowserIcon(id);
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
          const all = origin === "*";
          const name = all ? t("browser.allSites") : origin.replace(/^https:\/\//, "");
          return (
            <div className={`frow mrow site-row ${level === "deny" ? "denied" : ""}`} key={origin}>
              <SiteIcon origin={all ? null : origin} className="site-icon" fallback={<Icon name="globe" />} />
              <div className="ft">
                <div className={`fn ${all ? "" : "mono"}`} title={all ? undefined : origin}>{name}</div>
                {all && <div className="fdesc">{t("browser.allSitesDesc")}</div>}
              </div>
              <select
                className="psel"
                aria-label={t("browser.siteLevel", { site: name })}
                value={level}
                onChange={(e) => void write([{ key_path: siteKey(origin), value: e.target.value }])}
              >
                {/* "All sites" is never refused as a whole: that is the domain lists' job. */}
                {LEVELS.filter((l) => !all || l !== "deny").map((l) => (
                  <option key={l} value={l}>
                    {t(`browser.level.${l}`)}
                  </option>
                ))}
              </select>
              <button className="tb" title={t("browser.removeSite", { site: name })} aria-label={t("browser.removeSite", { site: name })} onClick={() => void write([{ key_path: siteKey(origin), value: null }])}>
                <Icon name="trash" />
              </button>
            </div>
          );
        })}
      </div>
      <p className="set-note">{t("browser.sitesNote")}</p>
    </section>
  );
}
