import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { recentProjects } from "@finx/client";
import type { McpServerView } from "@finx/protocol";
import { catalogOf, fromRepo, statusOf } from "../customize/model";
import { ServerTile } from "../customize/parts";
import { pageCwd, useCustomize, type Customize } from "../customize/useCustomize";
import { Icon } from "../icons";
import { useStore, type CustomizeView } from "../store";
import { SubMenuItem } from "./Composer";

// "+" › 连接器 (connectors-entry-design §7): browse and manage, a line, then the person's
// connectors, each with its switch. A switch is the connector's one switch, the same as on the
// 自定义 page; the menu stays open, so several can be changed in a row. The browsers and
// computer use are not connectors: their switches are in the "+" menu itself (QuickSwitches).

/** The folder whose connectors these are: the conversation's, or the one the new conversation goes to. */
function useFolder(): string | null {
  const st = useStore();
  const recent = useMemo(() => recentProjects(st.sessions.filter((s) => !s.archived)), [st.sessions]);
  const sel = st.selection;
  if (sel.kind === "session") {
    const s = st.sessions.find((x) => x.session_id === sel.id);
    return s && !s.no_project ? s.cwd : null;
  }
  return pageCwd(st, recent);
}

export function ConnectorsItem({ close }: { close: () => void }) {
  const { t } = useTranslation("session");
  const c = useCustomize(useFolder());
  const on = c.servers.filter((s) => s.enabled).length;
  return (
    <SubMenuItem icon="plug" label={t("composer.connectors")} value={String(on)} title={t("composer.connectors")} className="cn-sub">
      <Connectors close={close} c={c} />
    </SubMenuItem>
  );
}

/** Space and return toggle a row, as they click a button. */
export const activate = (run: () => void) => (e: KeyboardEvent) => {
  if (e.key !== " " && e.key !== "Enter") return;
  e.preventDefault();
  e.stopPropagation();
  run();
};

export const hoverFocus = (e: MouseEvent<HTMLElement>) => document.activeElement !== e.currentTarget && e.currentTarget.focus();

function Connectors({ close, c }: { close: () => void; c: Customize }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const go = (view: CustomizeView["view"], detail: CustomizeView["detail"] = null) => {
    close();
    st.set({ selection: { kind: "customize" }, customize: { tab: "connectors", view, detail } });
  };
  const name = (s: McpServerView) => catalogOf(s)?.name ?? s.name;
  const servers = [...c.servers].sort((a, b) => name(a).localeCompare(name(b)));
  return (
    <>
      <button className="mi" role="menuitem" tabIndex={-1} onMouseMove={hoverFocus} onClick={() => go("discover")}>
        <Icon name="search" />
        <span>{t("composer.browseConnectors")}</span>
      </button>
      <button className="mi" role="menuitem" tabIndex={-1} onMouseMove={hoverFocus} onClick={() => go("mine")}>
        <Icon name="gear" />
        <span>{t("composer.manageConnectors")}</span>
      </button>
      <div className="msep" role="separator" />
      <div className="cn-list">
        {servers.length === 0 && <div className="mi cn-none-row">{t("composer.noConnectors")}</div>}
        {servers.map((s) => (
          <ServerRow key={s.name} s={s} c={c} name={name(s)} open={() => go("mine", { kind: "connector", id: s.name, tab: "overview" })} />
        ))}
      </div>
    </>
  );
}

function ServerRow({ s, c, name, open }: { s: McpServerView; c: Customize; name: string; open: () => void }) {
  const { t } = useTranslation("customize");
  const look = statusOf(s, false);
  const untrusted = look.kind === "untrusted";
  // Only what needs the person shows; the rest is the 自定义 page's.
  const need = untrusted ? { text: t("menuNeed.untrusted"), cls: "" } : !s.enabled ? null : look.kind === "needs_login" ? { text: t("menuNeed.login"), cls: "" } : look.kind === "failed" ? { text: t("menuNeed.failed"), cls: "bad" } : null;
  const toggle = () => {
    if (untrusted) return;
    const on = !s.enabled;
    const done = fromRepo(s) ? t(on ? "toast.serverOnForYou" : "toast.serverOffForYou", { name: s.name }) : t(on ? "toast.serverOn" : "toast.serverOff", { name: s.name });
    void c.switchServer(s, on, done);
  };
  return (
    <div
      className={`mi cn-row ${s.enabled ? "" : "off"}`}
      role="menuitemcheckbox"
      aria-checked={s.enabled}
      aria-disabled={untrusted}
      tabIndex={-1}
      onMouseMove={hoverFocus}
      onClick={toggle}
      onKeyDown={activate(toggle)}
    >
      <ServerTile name={name} mono={catalogOf(s)?.mono} icon={s.icon} />
      <span className="nm">{name}</span>
      {need && (
        <button className={`cn-st ${need.cls}`} tabIndex={-1} onClick={(e) => (e.stopPropagation(), open())}>
          {need.text}
        </button>
      )}
      {!untrusted && <span className={`sw sm ${s.enabled ? "on" : ""}`} aria-hidden="true" />}
    </div>
  );
}
