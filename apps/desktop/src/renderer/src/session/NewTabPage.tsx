import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DevServer } from "../../../shared/bridge";
import { Icon } from "../icons";
import { useStore } from "../store";

// What a blank tab shows in the browser panel's room: the web servers running on this machine,
// asked for once as the tab opens, each a card that opens it. The tab's own view stays out of
// sight meanwhile (pages.ts), so the agent still finds an empty page. Each card can also stop its
// server, after asking: the process is ended and the list looked at again.

export function NewTabPage({ open }: { open: (url: string) => void }) {
  const { t } = useTranslation("session");
  const [servers, setServers] = useState<DevServer[] | null>(null);
  const [looking, setLooking] = useState(false);

  const look = useCallback(() => {
    const finx = window.finx;
    if (!finx) return setServers([]);
    setLooking(true);
    let live = true;
    finx.localServers()
      .then((s) => live && setServers(s))
      .catch(() => live && setServers([]))
      .finally(() => live && setLooking(false));
    return () => {
      live = false;
    };
  }, []);
  useEffect(look, [look]);

  const st = useStore();
  const stop = (s: DevServer) => {
    const v = { port: s.port, pid: s.pid, process: s.process || "?" };
    st.set({
      sheet: {
        kind: "confirm",
        title: t("browser.stopServerTitle", v),
        message: t("browser.stopServerBody", v),
        button: t("browser.stopServerButton"),
        done: t("browser.stopServerDone", v),
        run: async () => {
          const r = await window.finx!.stopLocalServer(s.port, s.pid);
          look();
          if (r === "gone") throw new Error(t("browser.stopServerGone", v));
          if (r === "denied") throw new Error(t("browser.stopServerDenied", v));
        },
      },
    });
  };

  return (
    <div className="ntp">
      <section className="ntp-sec">
        <header className="ntp-head">
          <h2>{t("browser.localServers")}</h2>
          <button className="ntp-rescan" disabled={looking} onClick={() => look()}>
            {t("browser.rescan")}
          </button>
        </header>
        {servers === null ? (
          <div className="ntp-grid" aria-busy="true">
            <div className="ntp-card ghost" />
            <div className="ntp-card ghost" />
          </div>
        ) : servers.length === 0 ? (
          <p className="ntp-empty">{t("browser.noLocalServers")}</p>
        ) : (
          <div className="ntp-grid">
            {servers.map((s) => (
              <div key={s.port} className="ntp-item">
                <button className="ntp-card" title={s.url} onClick={() => open(s.url)}>
                  <span className="ntp-port"><span className="ntp-dot" aria-hidden="true" />:{s.port}</span>
                  <span className="ntp-title">{s.title || `localhost:${s.port}`}</span>
                  <span className="ntp-meta">{[s.framework, s.process].filter(Boolean).join(" · ")}</span>
                </button>
                {s.pid > 0 && (
                  <button className="ntp-stop" title={t("browser.stopServer")} aria-label={t("browser.stopServer")} onClick={() => stop(s)}>
                    <Icon name="stop" className="fill" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
