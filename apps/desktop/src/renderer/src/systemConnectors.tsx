import { useCallback, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import type { ConfigWriteResult } from "@finx/protocol";
import { useTranslation } from "react-i18next";
import { Dialog } from "./components";
import { useDesktopStatus } from "./desktopControl";
import { Icon } from "./icons";
import { BrowserMark, Guide, useBrowserState, useSystemBrowsers } from "./settings/BrowserSettings";
import { useDesktopConfig } from "./settings/DesktopSettings";
import { errorText, useStore, type Store } from "./store";

// The system connectors (docs/desktop/connectors-entry-design.md §4): the user's own browser
// and desktop control, which come with FinxWork. They show among the connectors with one
// switch each in the user's configuration, and each connects in its own way (§6): the
// extension's guide for the user's browser, the system's permissions for desktop control.
// The built-in browser is not one: it is simply on, and Settings › Browser can turn it off.

export type SystemKey = "yours" | "desktop";
export const SYSTEM_KEYS: SystemKey[] = ["yours", "desktop"];

/** A system connector's id among the connectors on the 自定义 page. */
export const systemId = (key: SystemKey) => `system:${key}`;
export const systemOf = (id: string): SystemKey | null => (id === "system:yours" ? "yours" : id === "system:desktop" ? "desktop" : null);

/** How many tools each brings (crates/finx-core/src/browser.rs, desktop.rs). */
export const SYSTEM_TOOLS = {
  yours: ["browser_navigate", "browser_snapshot", "browser_act", "browser_screenshot", "browser_wait", "browser_tabs", "browser_console", "browser_batch"],
  desktop: ["desktop_apps", "desktop_launch", "desktop_snapshot", "desktop_act", "desktop_screenshot"],
} as const;

export type SystemView = {
  key: SystemKey;
  /** Connected once: its switch is in the user's configuration (§4.3). */
  connected: boolean;
  on: boolean;
  /** What needs the person while it is on: the extension is gone or out of date; agent-desktop is not installed, or a permission is missing. */
  need: "reconnect" | "update" | "program" | "permission" | null;
  /** The connected browser, as "Google Chrome 156". */
  browser: string | null;
  /** Desktop control on a computer that has none. */
  unsupported: boolean;
};

/** The two system connectors as every page shows them, and their switches. */
export function useSystemConnectors() {
  const browser = useBrowserState();
  const desktop = useDesktopConfig();
  const { status: permissions, refresh } = useDesktopStatus(desktop.config?.executable);
  const views = useMemo<SystemView[]>(() => {
    const extension = browser.status?.extension ?? null;
    const yoursOn = browser.config?.extension === true;
    const desktopOn = desktop.config?.enabled === true;
    return [
      {
        key: "yours",
        connected: browser.config ? browser.config.extension !== null : false,
        on: yoursOn,
        need: !yoursOn || !browser.status ? null : extension?.problem ? "update" : extension ? null : "reconnect",
        browser: extension?.browser?.replace(/ (\d+)(\.\d+)+$/, " $1") ?? null,
        unsupported: false,
      },
      {
        key: "desktop",
        connected: desktop.config ? desktop.config.enabled !== null : false,
        on: desktopOn,
        need: !desktopOn || !permissions ? null : !permissions.program ? "program" : permissions.accessibility !== "granted" && permissions.accessibility !== "unsupported" ? "permission" : null,
        browser: null,
        unsupported: permissions?.accessibility === "unsupported",
      },
    ];
  }, [browser.config, browser.status, desktop.config, permissions]);
  const setOn = useCallback((key: SystemKey, on: boolean) => (key === "yours" ? browser.use(on) : desktop.setEnabled(on)), [browser, desktop]);
  return { views, setOn, loaded: !!browser.config && !!desktop.config, permissions, refreshPermissions: refresh, desktop };
}

/** A system connector's mark: one fixed glyph, muted like the initials of the others. */
export function SystemTile({ k, size }: { k: SystemKey; size?: "xl" }) {
  return (
    <div className={`cz-tile sys ${size ?? ""}`}>
      <Icon name={k === "yours" ? "globe" : "laptop"} />
    </div>
  );
}

/**
 * Switches one and says so: that every conversation follows from its next step (D-224), or
 * that a project's file says otherwise (§5.1), as an MCP connector's switch does.
 */
export async function turn(st: Store, system: { setOn: (key: SystemKey, on: boolean) => Promise<ConfigWriteResult> }, key: SystemKey, on: boolean, t: TFunction<"customize">) {
  try {
    const over = (await system.setOn(key, on)).overridden_by?.[0];
    if (over) st.show(t(on ? "toast.overriddenOff" : "toast.overriddenOn", { name: t(`system.${key}.name`), file: over.file ?? over.layer }), undefined, true);
    else st.show(t(`system.${key}.${on ? "turnedOn" : "turnedOff"}`));
  } catch (e) {
    st.show(errorText(e), undefined, true);
  }
}

/** Opens a system connector's way of connecting over the window. */
export function connect(st: Store, key: SystemKey) {
  st.set({ connect: key });
}

/** The way of connecting that is open, if any: shown by the main window. */
export function ConnectHost() {
  const st = useStore();
  if (st.connect === "yours") return <ConnectYours onClose={() => st.set({ connect: null })} />;
  if (st.connect === "desktop") return <ConnectDesktop onClose={() => st.set({ connect: null })} />;
  return null;
}

/** The user's own browser: the extension's guide, from Settings › Browser as it is (§6.1). */
function ConnectYours({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("customize");
  const st = useStore();
  const { status, use } = useBrowserState();
  const { browsers, refresh } = useSystemBrowsers();
  const problem = status?.extension?.problem ?? null;
  const connected = !problem && !!status?.extension;
  if (!browsers) return null;
  if (browsers.length === 0)
    return (
      <Dialog label={t("browser.guide.title")} width={460} onClose={onClose}>
        <h3>{t("browser.guide.title")}</h3>
        <div className="cn-none">
          <BrowserMark />
          <p className="sub">{t("browser.none")}</p>
        </div>
        <div className="sheet-foot">
          <button className="btn" onClick={onClose}>
            {tc("system.cancel")}
          </button>
          <button className="btn primary" onClick={() => window.finx?.openExternal("https://www.google.com/chrome/")}>
            {t("browser.getChrome")}
          </button>
        </div>
      </Dialog>
    );
  return (
    <Guide
      browsers={browsers}
      connected={connected}
      problem={problem}
      onConnected={async () => {
        await use(true);
        st.show(tc("system.yours.connected"));
      }}
      refresh={refresh}
      onClose={() => {
        refresh();
        onClose();
      }}
    />
  );
}

/** Desktop control: agent-desktop where it is missing, the permissions FinxWork asks of the system, then on (§6.2). */
function ConnectDesktop({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("customize");
  const st = useStore();
  const { permissions, refreshPermissions, desktop } = useSystemConnectors();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const granted = !!permissions?.program && permissions.accessibility === "granted";
  const done = async () => {
    setBusy(true);
    setError("");
    try {
      await desktop.setEnabled(true);
      st.show(t("system.desktop.connected"));
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog label={t("system.desktop.connectTitle")} width={520} className="cn-sheet" onClose={onClose}>
      <h3>{t("system.desktop.connectTitle")}</h3>
      <p className="sub">{t("system.desktop.connectSub")}</p>
      <div className="fgroup">
        {permissions && !permissions.program && <ProgramRow recheck={refreshPermissions} />}
        {(["accessibility", "screen"] as const).map((kind) => (
          <div className="frow" key={kind}>
            <div className="ft">
              <div className="fn">
                {t(`system.desktop.${kind}`)} <span className="badge">{t(kind === "accessibility" ? "system.desktop.required" : "system.desktop.optional")}</span>
              </div>
              <div className="fdesc">{t(`system.desktop.${kind}Desc`)}</div>
            </div>
            {permissions?.[kind] === "granted" ? (
              <span className="cz-st ok">
                <i className="dotc on" />
                {t("system.desktop.granted")}
              </span>
            ) : (
              <button className="btn" onClick={() => window.finx?.requestDesktopPermission(kind)}>
                {t("system.desktop.openSettings")}
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="set-note">{t("system.desktop.permissionsNote")}</p>
      {error && <p className="mrow-err">{error}</p>}
      <div className="sheet-foot">
        <button className="btn" onClick={onClose}>
          {t("system.cancel")}
        </button>
        <button className="btn primary" disabled={!granted || busy} onClick={() => void done()}>
          {t("system.desktop.done")}
        </button>
      </div>
    </Dialog>
  );
}

/** agent-desktop is not where FinxWork looks: how to install it, and a check once it is. FinxWork ships its own, so this is for builds without it. */
export function ProgramRow({ recheck }: { recheck: () => void }) {
  const { t } = useTranslation("customize");
  return (
    <div className="frow">
      <div className="ft">
        <div className="fn">
          {t("system.desktop.program")} <span className="badge warn">{t("system.desktop.missing")}</span>
        </div>
        <div className="fdesc">
          {t("system.desktop.programDesc")} <code className="sel-text">npm install -g agent-desktop</code>
        </div>
      </div>
      <button className="btn" onClick={recheck}>
        {t("system.desktop.recheck")}
      </button>
    </div>
  );
}
