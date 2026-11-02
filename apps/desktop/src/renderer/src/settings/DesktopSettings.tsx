import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../icons";
import { useStore } from "../store";

// Settings › Desktop control: a link to its page among the connectors, where its switch
// (`desktop.enabled` in the user's own config; a project can only turn it off), the
// permissions FinxWork asks of the system, and what finx may do in each app without asking
// (`[desktop.apps]`, which an approval's "remember" fills) now are.

export type AppLevel = "read" | "act" | "deny";
export const LEVELS: AppLevel[] = ["read", "act", "deny"];

/** `desktop.apps."<key>"`: a bundle id has dots, so it is quoted. */
const appKeyPath = (key: string) => `desktop.apps."${key.replace(/["\\]/g, "\\$&")}"`;

/** The `[desktop]` settings, read again when the config changes. */
export function useDesktopConfig() {
  const st = useStore();
  // `enabled` is null when not set: desktop control was never connected.
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
      const r = await st.call("config/write", { layer: "user", edits: [{ key_path: "desktop.enabled", value: on }] });
      await read();
      return r;
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

/** Desktop control is a system connector now (connectors-entry-design §8): its switch, permissions and apps are on its page in 自定义. */
export function DesktopSettings() {
  const { t } = useTranslation("settings");
  return (
    <div className="form desktop-set">
      <section>
        <div className="fgroup">
          <div className="frow mrow">
            <span className="mtile">
              <Icon name="plug" />
            </span>
            <div className="ft">
              <div className="fn">{t("desktop.moved")}</div>
              <div className="fdesc">{t("desktop.movedDesc")}</div>
            </div>
            <button className="btn" onClick={() => window.finx?.showInMain("showDesktopControl")}>
              {t("desktop.open")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
