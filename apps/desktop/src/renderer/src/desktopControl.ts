import { useCallback, useEffect, useState } from "react";
import type { DesktopApp, DesktopControlStatus } from "../../shared/bridge";

// Desktop control as the page sees it: the program and the app's permissions (Settings ›
// Desktop control, and the approval of a desktop call), and the apps a grant names.

/** The origin a desktop app's grant is kept under (crates/finx-core site_policy). */
export const APP_ORIGIN = "app://";

/** The program and the permissions, asked again whenever the window comes back to the front (from System Settings, or a terminal). Not asked while `active` is false. */
export function useDesktopStatus(executable?: string, active = true) {
  const [status, setStatus] = useState<DesktopControlStatus | null>(null);
  const refresh = useCallback(() => void window.finx?.desktopControlStatus(executable).then(setStatus), [executable]);
  useEffect(() => {
    if (!active) return;
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh, active]);
  return { status, refresh };
}

/** A desktop app's name and icon by its key (a bundle id); null until known, or without a key. */
export function useDesktopApp(key: string | undefined): DesktopApp | null {
  const [app, setApp] = useState<DesktopApp | null>(null);
  useEffect(() => {
    setApp(null);
    if (!key) return;
    let live = true;
    void window.finx?.desktopApp(key).then((a) => live && setApp(a));
    return () => {
      live = false;
    };
  }, [key]);
  return app;
}
