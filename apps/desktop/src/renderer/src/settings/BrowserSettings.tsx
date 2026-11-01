import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserStatus } from "@finx/protocol";
import type { SystemBrowser, SystemBrowserId } from "../../../shared/bridge";
import { Dialog } from "../components";
import { Icon } from "../icons";
import { errorText, useStore } from "../store";
import { BuiltInBrowser } from "./BuiltInBrowser";

// Settings › Browser: the user's own browser (browser-design §8.4). One row says whether it
// is connected and in use, and offers the one thing to do; "Connect" walks through the
// setup: pick the browser, the app registers finx, the user adds the extension, and the
// app waits for it to connect, then turns it on.

/** The extension's page in the Chrome Web Store, once it is published; until then the guide loads it from its folder. */
const STORE_URL = "";

type Config = { enabled: boolean; backend: string };

/** finx's word on the browsers (browser/status, then browser/changed), and the [browser] settings. */
function useBrowserState() {
  const st = useStore();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const readConfig = useCallback(async () => {
    if (!st.rpc) return;
    const r = await st.rpc.request("config/read", {});
    const browser = ((r.config as Record<string, unknown>)?.browser ?? {}) as Record<string, unknown>;
    setConfig({ enabled: browser.enabled === true, backend: typeof browser.backend === "string" ? browser.backend : "auto" });
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
  /** Turns the user's browser on for the browser tools (new conversations), or back to the built-in one. */
  const use = useCallback(
    async (on: boolean) => {
      const edits = on
        ? [{ key_path: "browser.enabled", value: true }, { key_path: "browser.backend", value: "extension" }]
        : [{ key_path: "browser.backend", value: "auto" }];
      await st.call("config/write", { layer: "user", edits });
      await readConfig();
    },
    [st, readConfig],
  );
  return { status, config, use };
}

/** The browsers here, asked again whenever the window comes back to the front (the user may have opened or installed one). */
function useSystemBrowsers() {
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
  const { status, config, use } = useBrowserState();
  const { browsers, refresh } = useSystemBrowsers();
  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const connected = status?.extension ?? null;
  const inUse = !!config?.enabled && config.backend === "extension";
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

  let state: "none" | "on" | "ready" | "lost" | "off";
  if (browsers && browsers.length === 0 && !connected) state = "none";
  else if (connected) state = inUse ? "on" : "ready";
  else state = inUse ? "lost" : "off";

  // "Google Chrome 156.0.8078.76" reads as "Google Chrome 156".
  const name = connected?.browser?.replace(/ (\d+)(\.\d+)+$/, " $1") ?? mine?.name ?? "Chrome";
  const desc =
    state === "none" ? t("browser.none")
    : state === "on" ? t("browser.on")
    : state === "ready" ? t("browser.ready")
    : state === "lost" ? (mine && !mine.running ? t("browser.closed", { name: mine.name }) : t("browser.lost"))
    : t("browser.off");
  const badge =
    state === "on" ? <span className="badge ok">{t("browser.badge.on")}</span>
    : state === "ready" ? <span className="badge acc">{t("browser.badge.ready")}</span>
    : state === "lost" ? <span className="badge warn">{t("browser.badge.lost")}</span>
    : <span className="badge">{t("browser.badge.off")}</span>;

  return (
    <div className="form browser-set">
      <section>
        <h3 className="fhead">{t("browser.system")}</h3>
        <div className="fgroup">
          <div className="frow mrow">
            <BrowserMark id={mine?.id} />
            <div className="ft">
              <div className="fn">
                {state === "on" || state === "ready" ? name : t("browser.title")} {badge}
              </div>
              <div className={`fdesc ${state === "lost" ? "warn" : ""}`}>{desc}</div>
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
      <BuiltInBrowser />
      {guide && browsers && (
        <Guide
          browsers={browsers}
          connected={!!connected}
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
function BrowserMark({ id }: { id?: SystemBrowserId }) {
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
const WAIT_SECONDS = 10;

function Guide({
  browsers,
  connected,
  onConnected,
  refresh,
  onClose,
}: {
  browsers: SystemBrowser[];
  connected: boolean;
  onConnected: () => Promise<void>;
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
            ) : !browser.running ? (
              <p className="bg-lead">{t("browser.guide.notOpen", { name: browser.name })}</p>
            ) : (
              <p className="bg-lead"><span className="mini-spin" />{t("browser.guide.waiting", { name: browser.name })}{!slow && <span className="bg-count">{t("browser.guide.countdown", { count: left })}</span>}</p>
            )}
            {!error && browser.running && slow && <p className="set-note">{t("browser.guide.waitHint", { name: browser.name })}</p>}
            <div className="bg-actions">
              <button className="btn" onClick={() => setStep("install")}>{t("browser.guide.back")}</button>
              {!error && !browser.running && (
                <button className="btn primary" onClick={() => void window.finx?.openSystemBrowser(browser.id).then(refresh)}>{t("browser.open", { name: browser.name })}</button>
              )}
              {!error && browser.running && slow && (
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
