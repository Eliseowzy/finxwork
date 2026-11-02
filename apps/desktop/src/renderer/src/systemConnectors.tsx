import { useCallback, useMemo } from "react";
import type { TFunction } from "i18next";
import type { ConfigWriteResult } from "@finx/protocol";
import { useTranslation } from "react-i18next";
import { Dialog } from "./components";
import { Icon } from "./icons";
import { BrowserMark, Guide, useBrowserState, useSystemBrowsers } from "./settings/BrowserSettings";
import { errorText, useStore, type Store } from "./store";

// The system connectors (docs/desktop/connectors-entry-design.md §4): the user's own browser,
// which comes with FinxWork. It shows among the connectors with one switch in the user's
// configuration, and connects in its own way, the extension's guide (§6.1). The built-in
// browser is not one: it is simply on, and Settings › Browser can turn it off. Neither is
// computer use: it is on by default, and Settings › 电脑操控 holds its switch
// (computer-use-design.md).

export type SystemKey = "yours";
export const SYSTEM_KEYS: SystemKey[] = ["yours"];

/** A system connector's id among the connectors on the 自定义 page. */
export const systemId = (key: SystemKey) => `system:${key}`;
export const systemOf = (id: string): SystemKey | null => (id === "system:yours" ? "yours" : null);

/** The tools each brings (crates/finx-core/src/browser.rs). */
export const SYSTEM_TOOLS = {
  yours: ["browser_navigate", "browser_snapshot", "browser_act", "browser_screenshot", "browser_wait", "browser_tabs", "browser_console", "browser_batch"],
} as const;

export type SystemView = {
  key: SystemKey;
  /** Connected once: its switch is in the user's configuration (§4.3). */
  connected: boolean;
  on: boolean;
  /** What needs the person while it is on: the extension is gone or out of date. */
  need: "reconnect" | "update" | null;
  /** The connected browser, as "Google Chrome 156". */
  browser: string | null;
};

/** The system connectors as every page shows them, and their switches. */
export function useSystemConnectors() {
  const browser = useBrowserState();
  const views = useMemo<SystemView[]>(() => {
    const extension = browser.status?.extension ?? null;
    const yoursOn = browser.config?.extension === true;
    return [
      {
        key: "yours",
        connected: browser.config ? browser.config.extension !== null : false,
        on: yoursOn,
        need: !yoursOn || !browser.status ? null : extension?.problem ? "update" : extension ? null : "reconnect",
        browser: extension?.browser?.replace(/ (\d+)(\.\d+)+$/, " $1") ?? null,
      },
    ];
  }, [browser.config, browser.status]);
  const setOn = useCallback((_key: SystemKey, on: boolean) => browser.use(on), [browser]);
  return { views, setOn, loaded: !!browser.config };
}

/** A system connector's mark: one fixed glyph, muted like the initials of the others. */
export function SystemTile({ k, size }: { k: SystemKey; size?: "xl" }) {
  return (
    <div className={`cz-tile sys ${size ?? ""}`}>
      <Icon name="globe" />
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
