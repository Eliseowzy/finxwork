import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopControlStatus, DesktopPermission } from "../../../shared/bridge";
import { useDesktopApp, useDesktopStatus } from "../desktopControl";
import { Dialog } from "../components";
import { Icon } from "../icons";
import { errorText, useStore } from "../store";

// Settings › 电脑操控 (docs/desktop/computer-use-design.md): the computer use tools, which read
// and operate the person's other apps through agent-desktop. One switch, `desktop.enabled` in
// the user's own config: not set, it is on (a project can only turn it off). Until FinxWork has
// the system's Accessibility permission the switch is grey and the line under it asks for it;
// either opens the permissions in a dialog, where the app can open System Settings at the right
// page. agent-desktop itself comes with FinxWork; were it missing, the line says to reinstall.
// Then what finx may do in each app without asking, `[desktop.apps]`, which an approval's
// "remember" fills.

/** An app is allowed or denied (computer-use-design §4); `read` and `act` are from before, and allow. */
type AppLevel = "allow" | "deny" | "read" | "act";
const LEVELS: AppLevel[] = ["allow", "deny", "read", "act"];

/** `desktop.apps."<key>"`: a bundle id has dots, so it is quoted. */
const appKeyPath = (key: string) => `desktop.apps."${key.replace(/["\\]/g, "\\$&")}"`;

/** The `[desktop]` settings, read again when the config changes. `enabled` is null when not set: on. */
function useDesktopConfig() {
  const st = useStore();
  const [config, setConfig] = useState<{ enabled: boolean | null; executable?: string; apps: [string, AppLevel][] } | null>(null);
  const read = useCallback(async () => {
    if (!st.rpc) return;
    const r = await st.rpc.request("config/read", {});
    const desktop = ((r.config as Record<string, unknown>)?.desktop ?? {}) as Record<string, unknown>;
    const apps = Object.entries((desktop.apps ?? {}) as Record<string, unknown>).filter((e): e is [string, AppLevel] => LEVELS.includes(e[1] as AppLevel));
    setConfig({ enabled: typeof desktop.enabled === "boolean" ? desktop.enabled : null, executable: typeof desktop.executable === "string" ? desktop.executable : undefined, apps });
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
  const { status } = useDesktopStatus(config?.executable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [granting, setGranting] = useState(false);

  const on = config?.enabled !== false;
  const turn = async (value: boolean) => {
    setBusy(true);
    setError("");
    try {
      await setEnabled(value);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const unsupported = status?.accessibility === "unsupported";
  const missing = !!status && !unsupported && !status.program;
  const permitted = status?.accessibility === "granted";
  // Without Accessibility nothing works yet: the switch is grey, and asks for it.
  const needsGrant = !!status && !unsupported && !missing && !permitted;
  const needsScreen = on && permitted && status?.screen !== "granted";
  const grant = (
    <button className="link" onClick={() => setGranting(true)}>
      {t("desktop.grant")}
    </button>
  );
  return (
    <div className="form desktop-set">
      <section>
        <div className="fgroup">
          <div className="frow">
            <div className="ft">
              <div className="fn">{t("desktop.enable")}</div>
              <div className={`fdesc ${missing || needsGrant ? "warn" : ""}`}>
                {unsupported ? (
                  t("desktop.unsupported")
                ) : missing ? (
                  t("desktop.blockedProgram")
                ) : needsGrant ? (
                  <>
                    {t("desktop.needsGrant")} {grant}
                  </>
                ) : needsScreen ? (
                  <>
                    {t("desktop.needsScreen")} {grant}
                  </>
                ) : (
                  t("desktop.enableDesc")
                )}
              </div>
            </div>
            <button
              className={`sw ${on && !needsGrant && !missing && !unsupported ? "on" : ""}`}
              role="switch"
              aria-checked={on && !needsGrant && !missing && !unsupported}
              aria-label={t("desktop.enable")}
              disabled={!config || busy || !st.rpc || unsupported || missing}
              onClick={() => (needsGrant ? setGranting(true) : void turn(!on))}
            />
          </div>
        </div>
        {error && <p className="mrow-err">{error}</p>}
      </section>

      {/* Off, the apps are only shown: a fieldset disables every control in it. */}
      <fieldset className="desktop-sub" disabled={!on || unsupported}>
        {config && <AppsSection apps={config.apps} setApp={setApp} locked={on && needsGrant} />}
      </fieldset>

      {granting && status && (
        <GrantDialog
          status={status}
          onClose={() => setGranting(false)}
          onDone={() => {
            setGranting(false);
            // Asked for from the grey switch: once FinxWork has the permission, it is on.
            if (status.accessibility === "granted" && config?.enabled === false) void turn(true);
          }}
        />
      )}
    </div>
  );
}

/** The permissions computer use needs, over the page: each with its state, or the way to grant it. */
function GrantDialog({ status, onClose, onDone }: { status: DesktopControlStatus; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation("settings");
  return (
    <Dialog label={t("desktop.grantTitle")} width={500} className="cu-grant" onClose={onClose}>
      <h3>{t("desktop.grantTitle")}</h3>
      <p className="sub">{t("desktop.grantIntro")}</p>
      <div className="fgroup">
        <PermissionRow kind="accessibility" state={status.accessibility} />
        <PermissionRow kind="screen" state={status.screen} />
      </div>
      <p className="set-note">{t("desktop.permissionsNote")}</p>
      <div className="sheet-foot">
        <button className="btn primary" onClick={onDone}>
          {t("desktop.done")}
        </button>
      </div>
    </Dialog>
  );
}

/** `[desktop.apps]`: each app finx may read or act in without asking, or never. */
function AppsSection({ apps, setApp, locked }: { apps: [string, AppLevel][]; setApp: (key: string, level: AppLevel | null) => Promise<void>; locked: boolean }) {
  const { t } = useTranslation("settings");
  const [error, setError] = useState("");
  const change = (key: string, level: AppLevel | null) => {
    setError("");
    setApp(key, level).catch((e) => setError(errorText(e)));
  };
  // Picking an app is macOS's own dialog; elsewhere apps come only from approvals.
  const canPick = window.finx?.platform === "mac";
  /** An app picked in the system's dialog: allowed, unless it is listed already. */
  const add = async () => {
    setError("");
    try {
      const app = await window.finx?.pickDesktopApp();
      if (app && !apps.some(([key]) => key.toLowerCase() === app.key.toLowerCase())) await setApp(app.key, "allow");
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section>
      <h3 className="fhead">{t("desktop.apps")}</h3>
      <p className="set-note apps-intro">{t(locked ? "desktop.appsLocked" : "desktop.appsIntro")}</p>
      <div className="fgroup">
        {apps.length === 0 && (
          <div className="frow">
            <div className="ft">
              <div className="fdesc">{t("desktop.appsEmpty")}</div>
            </div>
          </div>
        )}
        {apps.map(([key, level]) => (
          <AppRow key={key} appKey={key} level={level} change={change} />
        ))}
        {canPick && (
          <button className="frow mrow-add" onClick={() => void add()}>
            <Icon name="plus" />
            {t("desktop.add")}
          </button>
        )}
      </div>
      {error && <p className="mrow-err">{error}</p>}
    </section>
  );
}

/** An app: allowed or denied, a click apart, and removed to ask again. */
function AppRow({ appKey, level, change }: { appKey: string; level: AppLevel; change: (key: string, level: AppLevel | null) => void }) {
  const { t } = useTranslation("settings");
  const app = useDesktopApp(appKey);
  const name = app?.name ?? appKey;
  const allowed = level !== "deny";
  return (
    <div className={`frow mrow app-row ${allowed ? "" : "denied"}`}>
      {app?.icon ? <img className="app-icon" src={app.icon} alt="" /> : <span className="app-icon" />}
      <div className="ft">
        <div className="fn" title={appKey}>
          {name} {!allowed && <span className="badge warn">{t("desktop.denied")}</span>}
        </div>
      </div>
      <button
        className="tb app-toggle"
        aria-pressed={allowed}
        title={t(allowed ? "desktop.allowedTitle" : "desktop.deniedTitle", { name })}
        aria-label={t(allowed ? "desktop.allowedTitle" : "desktop.deniedTitle", { name })}
        onClick={() => change(appKey, allowed ? "deny" : "allow")}
      >
        <Icon name={allowed ? "unlock" : "lock"} />
      </button>
      <button className="tb" title={t("desktop.forgetNamed", { name })} aria-label={t("desktop.forgetNamed", { name })} onClick={() => change(appKey, null)}>
        <Icon name="trash" />
      </button>
    </div>
  );
}

/** One permission: required or optional, whether FinxWork has it, and the way to grant it when not. */
function PermissionRow({ kind, state }: { kind: "accessibility" | "screen"; state: DesktopPermission }) {
  const { t } = useTranslation("settings");
  const granted = state === "granted";
  return (
    <div className="frow">
      <div className="ft">
        <div className="fn">
          {t(`desktop.${kind}`)} <span className="badge">{t(kind === "accessibility" ? "desktop.required" : "desktop.optional")}</span>
        </div>
        <div className="fdesc">{t(`desktop.${kind}Desc`)}</div>
      </div>
      {granted ? (
        <span className="badge ok">{t("desktop.granted")}</span>
      ) : (
        <button className={`btn ${kind === "accessibility" ? "primary" : ""}`} onClick={() => window.finx?.requestDesktopPermission(kind)}>
          {t("desktop.openSettings")}
        </button>
      )}
    </div>
  );
}
