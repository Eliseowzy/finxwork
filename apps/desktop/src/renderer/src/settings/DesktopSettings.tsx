import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopPermission } from "../../../shared/bridge";
import { useDesktopApp, useDesktopStatus } from "../desktopControl";
import { errorText, useStore } from "../store";

// Settings › Desktop control: finx's desktop tools, which read and operate the person's
// other apps through agent-desktop. The switch is `desktop.enabled` in the user's own config
// (a project can only turn it off); the permissions are FinxWork's own, so they are asked of
// the system here, where the app can open System Settings at the right page. What finx may do
// in each app without asking is `[desktop.apps]`, which an approval's "remember" fills.

type AppLevel = "read" | "act" | "deny";
const LEVELS: AppLevel[] = ["read", "act", "deny"];

/** `desktop.apps."<key>"`: a bundle id has dots, so it is quoted. */
const appKeyPath = (key: string) => `desktop.apps."${key.replace(/["\\]/g, "\\$&")}"`;

/** The `[desktop]` settings, read again when the config changes. */
function useDesktopConfig() {
  const st = useStore();
  const [config, setConfig] = useState<{ enabled: boolean; executable?: string; apps: [string, AppLevel][] } | null>(null);
  const read = useCallback(async () => {
    if (!st.rpc) return;
    const r = await st.rpc.request("config/read", {});
    const desktop = ((r.config as Record<string, unknown>)?.desktop ?? {}) as Record<string, unknown>;
    const apps = Object.entries((desktop.apps ?? {}) as Record<string, unknown>).filter((e): e is [string, AppLevel] => LEVELS.includes(e[1] as AppLevel));
    setConfig({ enabled: desktop.enabled === true, executable: typeof desktop.executable === "string" ? desktop.executable : undefined, apps });
  }, [st.rpc]);
  useEffect(() => {
    const rpc = st.rpc;
    if (!rpc) return;
    void read().catch(() => {});
    return rpc.on("config/changed", () => void read().catch(() => {}));
  }, [st.rpc, read]);
  const setEnabled = useCallback(
    async (on: boolean) => {
      await st.call("config/write", { layer: "user", edits: [{ key_path: "desktop.enabled", value: on }] });
      await read();
    },
    [st, read],
  );
  /** Sets what finx may do in an app without asking; null asks again. */
  const setApp = useCallback(
    async (key: string, level: AppLevel | null) => {
      await st.call("config/write", { layer: "user", edits: [{ key_path: appKeyPath(key), value: level }] });
      await read();
    },
    [st, read],
  );
  return { config, setEnabled, setApp };
}

export function DesktopSettings() {
  const { t } = useTranslation("settings");
  const st = useStore();
  const { config, setEnabled, setApp } = useDesktopConfig();
  const { status, refresh } = useDesktopStatus(config?.executable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (!config) return;
    setBusy(true);
    setError("");
    try {
      await setEnabled(!config.enabled);
      // Switched on without the one permission it cannot work without: ask for it right away.
      if (!config.enabled && status?.accessibility === "denied") window.finx?.requestDesktopPermission("accessibility");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const on = !!config?.enabled;
  // On, but it cannot work yet: say what is missing right under the switch.
  const blocked = on && status && (!status.program || status.accessibility === "denied");
  return (
    <div className="form desktop-set">
      <section>
        <div className="fgroup">
          <div className="frow">
            <div className="ft">
              <div className="fn">{t("desktop.enable")}</div>
              <div className={`fdesc ${blocked ? "warn" : ""}`}>
                {blocked ? t(!status!.program ? "desktop.blockedProgram" : "desktop.blockedPermission") : t("desktop.enableDesc")}
              </div>
            </div>
            <button
              className={`sw ${on ? "on" : ""}`}
              role="switch"
              aria-checked={on}
              aria-label={t("desktop.enable")}
              disabled={!config || busy || !st.rpc}
              onClick={() => void toggle()}
            />
          </div>
        </div>
        {error && <p className="mrow-err">{error}</p>}
        <p className="set-note">{t("desktop.note")}</p>
      </section>

      {config && <AppsSection apps={config.apps} setApp={setApp} />}

      {status && status.accessibility !== "unsupported" && (
        <section>
          <h3 className="fhead">{t("desktop.permissions")}</h3>
          <div className="fgroup">
            <PermissionRow kind="accessibility" state={status.accessibility} />
            <PermissionRow kind="screen" state={status.screen} />
          </div>
          <p className="set-note">{t("desktop.permissionsNote")}</p>
        </section>
      )}

      <section>
        <h3 className="fhead">{t("desktop.program")}</h3>
        <div className="fgroup">
          <div className="frow">
            <div className="ft">
              <div className="fn">
                agent-desktop{" "}
                {status?.program ? (
                  <span className="badge ok">{t(status.program.bundled ? "desktop.bundled" : "desktop.installed")}</span>
                ) : (
                  status && <span className="badge warn">{t("desktop.missing")}</span>
                )}
              </div>
              <div className="fdesc">
                {!status ? t("desktop.checking")
                : status.program ? (
                  <>
                    {status.program.version ? t("desktop.version", { version: status.program.version }) : t("desktop.noVersion")}
                    {" · "}
                    <span className="mono sel-text">{status.program.path}</span>
                  </>
                ) : (
                  <>
                    {t("desktop.install")} <code className="sel-text">npm install -g agent-desktop</code>
                  </>
                )}
              </div>
            </div>
            {status?.program ? (
              <button className="btn" onClick={() => window.finx?.revealPath(status.program!.path)}>{t("desktop.show")}</button>
            ) : (
              <button className="btn" disabled={!status} onClick={refresh}>{t("desktop.recheck")}</button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

/** `[desktop.apps]`: each app finx may read or act in without asking, or never. */
function AppsSection({ apps, setApp }: { apps: [string, AppLevel][]; setApp: (key: string, level: AppLevel | null) => Promise<void> }) {
  const { t } = useTranslation("settings");
  const [error, setError] = useState("");
  const change = (key: string, level: AppLevel | null) => {
    setError("");
    setApp(key, level).catch((e) => setError(errorText(e)));
  };
  return (
    <section>
      <h3 className="fhead">{t("desktop.apps")}</h3>
      <div className="fgroup">
        {apps.length === 0 ? (
          <div className="frow">
            <div className="ft">
              <div className="fdesc">{t("desktop.appsEmpty")}</div>
            </div>
          </div>
        ) : (
          apps.map(([key, level]) => <AppRow key={key} appKey={key} level={level} change={change} />)
        )}
      </div>
      {error && <p className="mrow-err">{error}</p>}
      <p className="set-note">{t("desktop.appsNote")}</p>
    </section>
  );
}

function AppRow({ appKey, level, change }: { appKey: string; level: AppLevel; change: (key: string, level: AppLevel | null) => void }) {
  const { t } = useTranslation("settings");
  const app = useDesktopApp(appKey);
  const name = app?.name ?? appKey;
  return (
    <div className="frow mrow">
      {app?.icon ? <img className="app-icon" src={app.icon} alt="" /> : <span className="app-icon" />}
      <div className="ft">
        <div className="fn">{name}</div>
        <div className="fdesc mono sel-text">{appKey}</div>
      </div>
      <select className="psel" aria-label={t("desktop.appLevel", { name })} value={level} onChange={(e) => change(appKey, e.target.value as AppLevel)}>
        {LEVELS.map((l) => (
          <option key={l} value={l}>
            {t(`desktop.level.${l}`)}
          </option>
        ))}
      </select>
      <button className="btn" aria-label={t("desktop.forgetNamed", { name })} onClick={() => change(appKey, null)}>
        {t("desktop.forget")}
      </button>
    </div>
  );
}

/** One permission: whether FinxWork has it, and the way to grant it when not. */
function PermissionRow({ kind, state }: { kind: "accessibility" | "screen"; state: DesktopPermission }) {
  const { t } = useTranslation("settings");
  const granted = state === "granted";
  return (
    <div className="frow">
      <div className="ft">
        <div className="fn">
          {t(`desktop.${kind}`)}{" "}
          {granted ? <span className="badge ok">{t("desktop.granted")}</span> : <span className={`badge ${kind === "accessibility" ? "warn" : ""}`}>{t("desktop.notGranted")}</span>}
        </div>
        <div className="fdesc">{t(`desktop.${kind}Desc`)}</div>
      </div>
      {!granted && (
        <button className={`btn ${kind === "accessibility" ? "primary" : ""}`} onClick={() => window.finx?.requestDesktopPermission(kind)}>
          {t("desktop.openSettings")}
        </button>
      )}
    </div>
  );
}
