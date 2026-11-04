import { useEffect, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { Appearance, KernelStatusView, NotificationSettings, Preferences } from "../../../shared/bridge";
import { i18n, languages, pickLanguage, resolveLanguage, type LanguageChoice } from "../../../shared/i18n";
import { SheetHost, ToastView } from "../components";
import { agoText } from "../format";
import { useUpdates } from "../updates";
import { Icon, Mark } from "../icons";
import { BrowserSettings } from "./BrowserSettings";
import { DesktopSettings } from "./DesktopSettings";
import { ModelConnections } from "./ModelConnections";
import { useStore } from "../store";
import "../styles/settings.css";

const pages = [
  { id: "general", icon: "gear" },
  { id: "notifications", icon: "bell" },
  { id: "models", icon: "cube" },
  { id: "browser", icon: "globe" },
  { id: "desktop", icon: "laptop" },
  { id: "about", icon: "info" },
] as const;

type Page = (typeof pages)[number]["id"];

const pageOf = (s: string): Page => pages.find((p) => p.id === s)?.id ?? "general";

/**
 * The settings window (#settings or #settings/<page>), laid out as System
 * Settings: the pages in a sidebar, the page on the right. Only what is the
 * app's own is set here in phase 1; what finx decides (providers, approval
 * rules, trust) comes with the kernel's support for it.
 */
export function SettingsWindow() {
  const { t } = useTranslation("settings");
  const [page, setPage] = useState<Page>(() => pageOf(location.hash.replace(/^#settings\/?/, "")));
  useEffect(() => window.finx?.onSettingsPage((p) => setPage(pageOf(p))), []);
  useEffect(() => {
    document.title = t(`pages.${page}`);
  }, [page, t]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && window.close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="settings">
      <aside className="side set-side">
        <div className="set-side-top drag" />
        <nav className="side-nav" aria-label={t("title")}>
          {pages.map((p) => (
            <button key={p.id} className={`nav-i ${p.id === page ? "sel" : ""}`} aria-current={p.id === page ? "page" : undefined} onClick={() => setPage(p.id)}>
              <Icon name={p.icon} />
              {t(`pages.${p.id}`)}
            </button>
          ))}
        </nav>
      </aside>
      <main className="set-main" aria-label={t(`pages.${page}`)}>
        <div className="set-top drag">
          <h1>{t(`pages.${page}`)}</h1>
        </div>
        <div className="set-body">
          {page === "general" && <General />}
          {page === "notifications" && <Notifications />}
          {page === "models" && <ModelConnections />}
          {page === "browser" && <BrowserSettings />}
          {page === "desktop" && <DesktopSettings />}
          {page === "about" && <About />}
        </div>
      </main>
      <SheetHost />
      <ToastView />
    </div>
  );
}

/** A setting: what it is, a line on what it means, and its control on the right. */
function SRow({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="frow">
      <div className="ft">
        <div className="fn">{title}</div>
        {desc && <div className="fdesc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

/** Notifications: this device's system notifications (notification-design §5.5). Muting a bot is in the bot's own settings. */
function Notifications() {
  const { t } = useTranslation("settings");
  const [prefs, setPrefs] = useState<Preferences>();
  useEffect(() => {
    window.finx?.getPreferences().then(setPrefs);
  }, []);
  const on = prefs?.notifications;
  const set = (p: Partial<NotificationSettings>) => window.finx?.setPreferences({ notifications: { ...on!, ...p } }).then(setPrefs);
  const toggle = (key: keyof NotificationSettings, label: string, disabled = false) => (
    <button className={`sw ${on?.[key] ? "on" : ""}`} role="switch" aria-checked={!!on?.[key]} aria-label={label} disabled={!on || disabled} onClick={() => set({ [key]: !on![key] })} />
  );
  return (
    <div className="form">
      <div className="fgroup">
        <SRow title={t("notifications.enabled")} desc={t("notifications.enabledNote")}>
          {toggle("enabled", t("notifications.enabled"))}
        </SRow>
        <SRow title={t("notifications.sound")}>{toggle("sound", t("notifications.sound"), !on?.enabled)}</SRow>
        <SRow title={t("notifications.sessionEnded")} desc={t("notifications.sessionEndedNote")}>
          {toggle("sessionEnded", t("notifications.sessionEnded"), !on?.enabled)}
        </SRow>
      </div>
      <div className="fgroup">
        <SRow title={t("notifications.test")} desc={t("notifications.testNote")}>
          <button className="btn" onClick={() => window.finx?.testNotification()}>{t("notifications.testButton")}</button>
        </SRow>
        {window.finx?.platform === "mac" && (
          <SRow title={t("notifications.system")} desc={t("notifications.systemNote")}>
            <button className="btn" onClick={() => window.finx?.openNotificationSettings()}>{t("notifications.systemButton")}</button>
          </SRow>
        )}
      </div>
      <p className="set-note">{t("notifications.muteNote")}</p>
    </div>
  );
}

/** General: the appearance and the language, the app's own preferences. */
function General() {
  const { t } = useTranslation("settings");
  const [prefs, setPrefs] = useState<Preferences>();
  useEffect(() => {
    window.finx?.getPreferences().then(setPrefs);
  }, []);
  const set = (p: Partial<Preferences>) => window.finx?.setPreferences(p).then(setPrefs);
  const running = window.finx?.language;
  const system = pickLanguage(navigator.languages);
  const restart = prefs && running && resolveLanguage(prefs.language, navigator.languages) !== running;
  return (
    <div className="form">
      <div className="fgroup">
        <SRow title={t("appearance.title")}>
          <div className="seg" role="group" aria-label={t("appearance.title")}>
            {(["system", "light", "dark"] as Appearance[]).map((a) => (
              <button key={a} type="button" className={prefs?.appearance === a ? "on" : ""} aria-pressed={prefs?.appearance === a} disabled={!prefs} onClick={() => set({ appearance: a })}>
                {t(`appearance.${a}`)}
              </button>
            ))}
          </div>
        </SRow>
        <SRow
          title={t("language.title")}
          desc={
            restart && (
              <>
                {t("language.restartHint")}{" "}
                <button className="link" onClick={() => window.finx?.relaunch()}>{t("language.restartNow")}</button>
              </>
            )
          }
        >
          <select className="psel" aria-label={t("language.title")} value={prefs?.language ?? "system"} disabled={!prefs} onChange={(e) => set({ language: e.target.value as LanguageChoice })}>
            <option value="system">{t("language.system", { name: t(`language.names.${system}`) })}</option>
            {languages.map((l) => (
              <option key={l} value={l}>{t(`language.names.${l}`)}</option>
            ))}
          </select>
        </SRow>
      </div>
      {!window.finx && <p className="set-note">{t("browserNote")}</p>}
    </div>
  );
}

function About() {
  const { t } = useTranslation("settings");
  const st = useStore();
  return (
    <div className="form">
      <div className="about">
        <Mark size={64} />
        <div>
          <b>FinxWork</b>
          <span>{t("about.version", { version: window.finx?.version ?? "dev" })}</span>
        </div>
      </div>
      <Updates />
      <div className="fgroup">
        <SRow title={t("about.kernel")}>
          <span className="fv-side">{window.finx?.kernel === "finx" ? kernelLine(st.status, st.server, t) : t("about.mock")}</span>
        </SRow>
        {st.status?.binary && (
          <SRow title={t("about.binary")}>
            <span className="fv-side mono sel-text">{st.status.binary}</span>
          </SRow>
        )}
        {st.status && window.finx?.kernel === "finx" && (
          <SRow title={t("about.started")}>
            <span className="fv-side">{st.status.ours === false ? t("about.startedElsewhere") : t("about.startedHere")}</span>
          </SRow>
        )}
        {st.status?.env && (
          <SRow title={t("about.env")}>
            <span className="fv-side">{t(`about.env_${st.status.env}`)}</span>
          </SRow>
        )}
        <SRow title={t("about.data")}>
          <span className="fv-side mono sel-text">{st.status?.home ?? "~/.finx"}</span>
        </SRow>
      </div>
      {window.finx?.kernel === "finx" && (
        <div className="about-actions">
          <button className="btn" onClick={() => restart(st)}>{t("about.restart")}</button>
          {st.status?.log && (
            <button className="btn" onClick={() => window.finx?.revealPath(st.status!.log)}>
              {t("about.showLog")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Software Update: where the app is with its next version, the one thing to do about it, and automatic download. */
function Updates() {
  const { t } = useTranslation("settings");
  const info = useUpdates();
  if (!info) return null;
  const u = info.update;
  const k = (key: string) => t(`about.updates.${key}` as "about.updates.title", { version: "version" in u ? u.version : "" });
  const checked = info.checkedAt ? t("about.updates.checkedAt", { time: agoText(new Date(info.checkedAt), new Date()) }) : null;
  const notes = info.notesURL && (u.state === "available" || u.state === "ready") && (
    <>
      {" "}
      <button className="link" onClick={() => window.finx?.openExternal(info.notesURL!)}>{k("notes")}</button>
    </>
  );
  const desc =
    u.state === "unsupported" ? k("unsupported")
    : u.state === "idle" ? (checked ?? k("idle"))
    : u.state === "checking" || u.state === "downloading" ? <span className="upd-busy"><span className="mini-spin" />{k(u.state)}</span>
    : u.state === "current" ? [k("current"), checked].filter(Boolean).join(" · ")
    : u.state === "error" ? (
        <>
          {t(`about.updates.error.${u.reason}`)}
          <details className="upd-details">
            <summary>{k("details")}</summary>
            <div className="upd-raw sel-text">{u.message}</div>
          </details>
        </>
      )
    : <>{k(u.state)}{notes}</>;
  const check = () => window.finx?.checkForUpdates();
  const action =
    u.state === "unsupported" ? null
    : u.state === "available" ? <button className="btn primary" onClick={() => window.finx?.downloadUpdate()}>{k("download")}</button>
    : u.state === "ready" ? <button className="btn primary" onClick={() => window.finx?.installUpdate()}>{k("restart")}</button>
    : u.state === "error" ? <button className="btn" onClick={check}>{k("retry")}</button>
    : <button className="btn" disabled={u.state === "checking" || u.state === "downloading"} onClick={check}>{k("check")}</button>;
  return (
    <div className="fgroup">
      <SRow title={k("title")} desc={desc}>{action}</SRow>
      {u.state !== "unsupported" && (
        <SRow title={k("auto")} desc={k("autoDesc")}>
          <button className={`sw ${info.autoDownload ? "on" : ""}`} role="switch" aria-checked={info.autoDownload} aria-label={k("auto")} onClick={() => window.finx?.setAutoDownload(!info.autoDownload)} />
        </SRow>
      )}
    </div>
  );
}

function kernelLine(status: KernelStatusView | null, server: string, t: TFunction<"settings">): string {
  if (!status) return server || "—";
  if (status.state === "failed") return t("about.kernelFailed", { reason: status.reason ?? "" });
  if (status.state === "starting") return t("about.kernel_starting");
  if (status.state === "reconnecting") return t("about.kernel_reconnecting");
  return status.replacing ? t("about.kernelUpdate", { server }) : server || "—";
}

/** Starts finx again (fresh login environment); with tasks running, after asking. */
function restart(st: ReturnType<typeof useStore>) {
  const running = st.sessions.some((s) => s.state === "running" || s.state === "awaiting_approval");
  if (!running) return window.finx?.restartKernel(true);
  const t = i18n.getFixedT(null, "settings");
  st.set({
    sheet: {
      kind: "confirm",
      title: t("about.restartTitle"),
      message: t("about.restartBusy"),
      button: t("about.restartNow"),
      run: async () => window.finx?.restartKernel(true),
    },
  });
}
