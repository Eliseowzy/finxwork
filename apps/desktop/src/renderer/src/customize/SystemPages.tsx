import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useDesktopApp } from "../desktopControl";
import { Icon } from "../icons";
import { LEVELS, type AppLevel } from "../settings/DesktopSettings";
import { errorText, useStore } from "../store";
import { connect, SYSTEM_TOOLS, SystemTile, turn, useSystemConnectors, type SystemKey, type SystemView } from "../systemConnectors";
import { AddMark, Card } from "./Lists";
import { MoreButton, PopUp, Section, Status, Switch, type MenuItem } from "./parts";
import type { Actions } from "./Lists";

// The system connectors on the 自定义 page (connectors-entry-design §8): a group of their own
// in 我的, two cards in 发现, and a page each, laid out like a connector's page (customize-design
// §10.12). They connect in their own way and cannot be removed.

type System = ReturnType<typeof useSystemConnectors>;

/** What setting a need right is called; each opens the connector's way of connecting. */
const FIX = { reconnect: "system.yours.reconnect", update: "system.yours.update", program: "system.desktop.install", permission: "system.desktop.grant" } as const;

/** The menu of a system connector's row and page. */
function systemMenu(key: SystemKey, st: ReturnType<typeof useStore>, t: TFunction<"customize">, view?: () => void): MenuItem[] {
  return [
    ...(view ? [{ id: "view", label: t("system.view"), icon: "info", run: view }] : []),
    key === "yours"
      ? { id: "change", label: t("system.yours.change"), icon: "globe", run: () => connect(st, "yours") }
      : { id: "permissions", label: t("system.desktop.permissions"), icon: "shield", run: () => connect(st, "desktop") },
  ];
}

/** 我的 › 系统: always there; 连接 until connected, then its state, switch and menu; one this computer cannot have says so. */
export function SystemSection({ a }: { a: Actions }) {
  const { t } = useTranslation("customize");
  const st = useStore();
  const system = useSystemConnectors();
  const views = system.views;
  if (!system.loaded) return null;
  return (
    <Section title={t("system.group")} count={views.length} hint={t("system.groupHint")}>
      <div className="cz-rows">
        {views.map((v) => {
          const open = () => a.open({ kind: "connector", id: `system:${v.key}`, tab: "overview" });
          return (
            <div key={v.key} className={`cz-row ${v.connected && !v.on ? "off" : ""}`} role="button" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open()}>
              <SystemTile k={v.key} />
              <div className="rt">
                <div className="rn">
                  <span className="nm">{t(`system.${v.key}.name`)}</span>
                </div>
                <div className="rd">{rowLine(t, v)}</div>
              </div>
              <div className="ra" onClick={(e) => e.stopPropagation()}>
                {v.unsupported ? (
                  <span className="cz-st">{t("system.unsupported")}</span>
                ) : v.connected ? (
                  <>
                    <StateText v={v} />
                    <Switch on={v.on} label={t(v.on ? "connector.turnOff" : "connector.turnOn")} onChange={(on) => void turn(st, system, v.key, on, t)} />
                    <MoreButton label={t("more")} items={() => systemMenu(v.key, st, t, open)} />
                  </>
                ) : (
                  <button className="btn" onClick={() => connect(st, v.key)}>
                    {t("system.connect")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** A row's second line: what it is before it is connected; then which browser, or what it reaches. */
function rowLine(t: TFunction<"customize">, v: SystemView): string {
  if (!v.connected) return t(`system.${v.key}.pitch`);
  if (v.key === "yours") return v.browser ? t("system.yours.line", { browser: v.browser.replace(/ \d+$/, "") }) : t("system.yours.lineNoBrowser");
  return t("system.desktop.line");
}

/** The state beside the switch: what needs doing, else available with its tools, else off. */
function StateText({ v }: { v: SystemView }) {
  const { t } = useTranslation("customize");
  const st = useStore();
  if (v.need)
    return (
      <span className="cz-st warn">
        <i className="dotc warn" />
        {t(`system.need.${v.need}`)}
        {" · "}
        <button className="link" onClick={() => connect(st, v.key)}>
          {t(FIX[v.need])}
        </button>
      </span>
    );
  if (!v.on) return <Status look={{ kind: "off", forYou: false }} onCheck={() => {}} />;
  return (
    <span className="cz-st ok">
      <i className="dotc on" />
      {t("system.available", { count: SYSTEM_TOOLS[v.key].length })}
    </span>
  );
}

/** 发现 › 系统连接器: two cards; + connects, a check once connected; one this computer cannot have says so instead. */
export function SystemCards({ a }: { a: Actions }) {
  const { t } = useTranslation("customize");
  const st = useStore();
  const system = useSystemConnectors();
  const views = system.views;
  if (!system.loaded) return null;
  return (
    <Section title={t("system.cards")} count={views.length}>
      <div className="cz-grid">
        {views.map((v) => (
          <Card
            key={v.key}
            tile={<SystemTile k={v.key} />}
            name={t(`system.${v.key}.name`)}
            added={v.connected || v.unsupported}
            addedLabel={t(v.unsupported ? "system.unsupported" : "system.connected")}
            description={t(`system.${v.key}.card`)}
            by={t("system.by")}
            mark={v.unsupported ? null : <AddMark added={v.connected} busy={false} name={t(`system.${v.key}.name`)} onAdd={() => connect(st, v.key)} />}
            onOpen={() => a.open({ kind: "connector", id: `system:${v.key}`, tab: "overview" })}
          />
        ))}
      </div>
    </Section>
  );
}

/** A system connector's own page. */
export function SystemPage({ k, onBack }: { k: SystemKey; onBack: () => void }) {
  const { t } = useTranslation("customize");
  const st = useStore();
  const system = useSystemConnectors();
  const v = system.views.find((x) => x.key === k)!;
  const [open, setOpen] = useState<string | null>(null);
  if (!system.loaded) return null;
  const state = v.unsupported
    ? { cls: "", dot: "", text: t("system.unsupported") }
    : !v.connected
    ? { cls: "", dot: "", text: t("system.notConnected") }
    : v.need
      ? { cls: "warn", dot: "warn", text: t(`system.need.${v.need}`) }
      : v.on
        ? { cls: "ok", dot: "on", text: t("system.availableShort") }
        : { cls: "", dot: "", text: t("system.off") };
  return (
    <div className={`cz-dpage ${v.connected && !v.on ? "off" : ""}`}>
      <div className="cz-dbar">
        <button className="cz-back" onClick={onBack}>
          <Icon name="arrowLeft" />
          {t("connector.back")}
        </button>
      </div>
      <div className="cz-dhead">
        <div className="cz-dtitle">
          <SystemTile k={k} size="xl" />
          <h1>{t(`system.${k}.name`)}</h1>
          <span className="badge">{t("system.badge")}</span>
          <div className="cz-dacts">
            {v.connected ? (
              <>
                <label className="cz-swl">
                  {t("connector.enabled")}
                  <Switch on={v.on} label={t(v.on ? "connector.turnOff" : "connector.turnOn")} onChange={(on) => void turn(st, system, k, on, t)} />
                </label>
                <MoreButton label={t("more")} items={() => systemMenu(k, st, t)} />
              </>
            ) : (
              !v.unsupported && (
                <button className="btn cz-solid" onClick={() => connect(st, k)}>
                  {t("system.connect")}
                </button>
              )
            )}
          </div>
        </div>
        <p className="cz-lede">{t(`system.${k}.lede`)}</p>
        <div className="cz-facts">
          <div className="cz-fact">
            <div className="k">{t("connector.state")}</div>
            <div className={`v cz-st ${state.cls}`}>
              {state.dot && <i className={`dotc ${state.dot}`} />}
              {state.text}
            </div>
          </div>
          {k === "yours" ? (
            <>
              {v.browser && (
                <div className="cz-fact">
                  <div className="k">{t("system.yours.browser")}</div>
                  <div className="v">{v.browser}</div>
                </div>
              )}
              <div className="cz-fact">
                <div className="k">{t("system.yours.when")}</div>
                <div className="v">{t("system.yours.whenValue")}</div>
              </div>
            </>
          ) : (
            !v.unsupported &&
            (["accessibility", "screen"] as const).map((kind) => (
              <div className="cz-fact" key={kind}>
                <div className="k">{t(`system.desktop.${kind}`)}</div>
                <div className="v">
                  {system.permissions?.[kind] === "granted" ? t("system.desktop.granted") : t("system.desktop.notGranted")}
                  {kind === "screen" && system.permissions?.screen !== "granted" && <span className="sub">{t("system.desktop.screenWhen")}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      {v.need && (
        <div className="cz-note warn">
          <Icon name="warn" />
          <div className="tx">
            <b>{t(`system.note.${v.need}.title`)}</b>
            {t(`system.note.${v.need}.text`)}
            {v.need === "program" && <code className="cz-cmd sel-text">npm install -g agent-desktop</code>}
          </div>
          {v.need === "program" ? (
            <button className="btn" onClick={system.refreshPermissions}>
              {t("system.desktop.recheck")}
            </button>
          ) : (
            <button className="btn" onClick={() => connect(st, k)}>
              {t(FIX[v.need])}
            </button>
          )}
        </div>
      )}
      {k === "yours" ? (
        <section className="cz-dtools cn-ds">
          <div className="cz-th">
            <h2>{t("system.yours.sites")}</h2>
          </div>
          <div className="cn-line">
            <span className="td">{t("system.yours.sitesText")}</span>
            <span className="acts">
              <button className="btn" onClick={() => window.finx?.openSettings("browser")}>
                {t("system.yours.sitesOpen")}
              </button>
            </span>
          </div>
        </section>
      ) : (
        v.connected && <DesktopSections system={system} />
      )}
      <section className="cz-dtools cn-ds">
        <div className="cz-th">
          <h2>{t("connector.tools")}</h2>
          <span className="n">{SYSTEM_TOOLS[k].length}</span>
          {k === "yours" && <span className="right">{t("system.yours.sharedTools")}</span>}
        </div>
        <div className="cz-tlist">
          {SYSTEM_TOOLS[k].map((name) => (
            <div key={name} className={`cz-tool ${open === name ? "open" : ""}`} onClick={() => setOpen(open === name ? null : name)}>
              <span className="tn">{name}</span>
              <span className="td">{t(`system.tools.${name}`)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** Desktop control's permissions, and what it may do in each app without asking (`[desktop.apps]`). */
function DesktopSections({ system }: { system: System }) {
  const { t } = useTranslation("customize");
  const [error, setError] = useState("");
  const apps = system.desktop.config?.apps ?? [];
  const setApp = (key: string, level: AppLevel | null) => {
    setError("");
    system.desktop.setApp(key, level).catch((e) => setError(errorText(e)));
  };
  // Picking an app is macOS's own dialog; elsewhere apps come only from approvals.
  const canPick = window.finx?.platform === "mac";
  const add = async () => {
    setError("");
    try {
      const app = await window.finx?.pickDesktopApp();
      if (app && !apps.some(([key]) => key.toLowerCase() === app.key.toLowerCase())) await system.desktop.setApp(app.key, "read");
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      <section className="cz-dtools cn-ds">
        <div className="cz-th">
          <h2>{t("system.desktop.permissions")}</h2>
        </div>
        <div className="cn-lines">
          {(["accessibility", "screen"] as const).map((kind) => (
            <div className="cn-line" key={kind}>
              <span className="tn">{t(`system.desktop.${kind}`)}</span>
              <span className="td">{t(`system.desktop.${kind}Desc`)}</span>
              <span className="acts">
                {system.permissions?.[kind] === "granted" ? (
                  <span className="cz-st ok">
                    <i className="dotc on" />
                    {t("system.desktop.granted")}
                  </span>
                ) : (
                  <button className="btn" onClick={() => window.finx?.requestDesktopPermission(kind)}>
                    {t("system.desktop.openSettings")}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="cz-dtools cn-ds">
        <div className="cz-th">
          <h2>{t("system.desktop.apps")}</h2>
          {apps.length > 0 && <span className="n">{apps.length}</span>}
          <span className="right">{t("system.desktop.appsHint")}</span>
        </div>
        {apps.length === 0 && <p className="cz-dempty">{t("system.desktop.appsEmpty")}</p>}
        <div className="cn-lines">
          {apps.map(([key, level]) => (
            <AppLine key={key} appKey={key} level={level} setApp={setApp} />
          ))}
        </div>
        {canPick && (
          <button className="btn cn-add" onClick={() => void add()}>
            <Icon name="plus" />
            {t("system.desktop.addApp")}
          </button>
        )}
        {error && <p className="mrow-err">{error}</p>}
      </section>
    </>
  );
}

function AppLine({ appKey, level, setApp }: { appKey: string; level: AppLevel; setApp: (key: string, level: AppLevel | null) => void }) {
  const { t } = useTranslation("customize");
  const app = useDesktopApp(appKey);
  const name = app?.name ?? appKey;
  return (
    <div className="cn-line">
      <span className="tn">
        {app?.icon && <img className="cn-app" src={app.icon} alt="" />}
        {name}
      </span>
      <span className="td mono">{appKey}</span>
      <span className="acts">
        <PopUp
          label={t("system.desktop.appLevel", { name })}
          value={level as string}
          choices={[...LEVELS.map((l) => ({ id: l as string, label: t(`system.desktop.level.${l}`) })), { id: "forget", label: t("system.desktop.forget") }]}
          onChange={(id) => setApp(appKey, id === "forget" ? null : (id as AppLevel))}
        />
      </span>
    </div>
  );
}
