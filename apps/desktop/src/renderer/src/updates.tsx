import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { remind, type UpdateInfo } from "../../shared/update";
import { Icon } from "./icons";

// The app's updates as the windows show them (desktop-release §4.4): the main
// process checks, downloads and installs (main/updater.ts); a window only
// shows where that is and asks for it.

/** Where the app is with its next version; null outside the app (the browser preview). */
export function useUpdates(): UpdateInfo | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    const finx = window.finx;
    if (!finx) return;
    let live = true;
    finx.updates().then((i) => live && setInfo(i));
    const off = finx.onUpdate(setInfo);
    return () => {
      live = false;
      off();
    };
  }, []);
  return info;
}

/** Above the sidebar's foot, while a found version waits: restart (or download), or "Later" for a day. */
export function UpdateReminder() {
  const { t } = useTranslation("common");
  const info = useUpdates();
  if (!info || !remind(info, Date.now())) return null;
  const u = info.update as { state: "ready" | "available"; version: string };
  const ready = u.state === "ready";
  return (
    <div className="upd" role="status">
      <Icon name="sparkle" />
      <b>{t(ready ? "update.ready" : "update.available", { version: u.version })}</b>
      <button className="upd-x" title={t("update.later")} aria-label={t("update.later")} onClick={() => window.finx?.snoozeUpdate()}>
        <Icon name="x" />
      </button>
      <span className="upd-h">{t(ready ? "update.readyHint" : "update.availableHint")}</span>
      <button className="btn sm primary" onClick={() => (ready ? window.finx?.installUpdate() : window.finx?.downloadUpdate())}>
        {t(ready ? "update.restart" : "update.download")}
      </button>
    </div>
  );
}
