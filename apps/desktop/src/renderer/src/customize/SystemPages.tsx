import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Icon } from "../icons";
import { useStore } from "../store";
import { connect, SYSTEM_TOOLS, SystemTile, turn, useSystemConnectors, type SystemKey, type SystemView } from "../systemConnectors";
import { AddMark, Card } from "./Lists";
import { MoreButton, Section, Status, Switch, type MenuItem } from "./parts";
import type { Actions } from "./Lists";

// The system connectors on the 自定义 page (connectors-entry-design §8): a group of their own
// in 我的, a card in 发现, and a page each, laid out like a connector's page (customize-design
// §10.12). They connect in their own way and cannot be removed.

/** What setting a need right is called; each opens the connector's way of connecting. */
const FIX = { reconnect: "system.yours.reconnect", update: "system.yours.update" } as const;

/** The menu of a system connector's row and page. */
function systemMenu(key: SystemKey, st: ReturnType<typeof useStore>, t: TFunction<"customize">, view?: () => void): MenuItem[] {
  return [
    ...(view ? [{ id: "view", label: t("system.view"), icon: "info", run: view }] : []),
    { id: "change", label: t("system.yours.change"), icon: "globe", run: () => connect(st, key) },
  ];
}

/** 我的 › 系统: always there; 连接 until connected, then its state, switch and menu. */
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
                {v.connected ? (
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

/** A row's second line: what it is before it is connected; then which browser. */
function rowLine(t: TFunction<"customize">, v: SystemView): string {
  if (!v.connected) return t(`system.${v.key}.pitch`);
  return v.browser ? t("system.yours.line", { browser: v.browser.replace(/ \d+$/, "") }) : t("system.yours.lineNoBrowser");
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

/** 发现 › 系统连接器: a card each; + connects, a check once connected. */
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
            added={v.connected}
            addedLabel={t("system.connected")}
            description={t(`system.${v.key}.card`)}
            by={t("system.by")}
            mark={<AddMark added={v.connected} busy={false} name={t(`system.${v.key}.name`)} onAdd={() => connect(st, v.key)} />}
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
  const state = !v.connected
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
              <button className="btn cz-solid" onClick={() => connect(st, k)}>
                {t("system.connect")}
              </button>
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
        </div>
      </div>
      {v.need && (
        <div className="cz-note warn">
          <Icon name="warn" />
          <div className="tx">
            <b>{t(`system.note.${v.need}.title`)}</b>
            {t(`system.note.${v.need}.text`)}
          </div>
          <button className="btn" onClick={() => connect(st, k)}>
            {t(FIX[v.need])}
          </button>
        </div>
      )}
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
      <section className="cz-dtools cn-ds">
        <div className="cz-th">
          <h2>{t("connector.tools")}</h2>
          <span className="n">{SYSTEM_TOOLS[k].length}</span>
          <span className="right">{t("system.yours.sharedTools")}</span>
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
