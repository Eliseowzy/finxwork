import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { projectNames, recentProjects } from "@finx/client";
import type { ConfigLayer, McpServerView } from "@finx/protocol";
import type { CatalogConnector, CatalogSkill } from "../../../shared/catalog";
import { SidebarToggle } from "../components";
import { Icon } from "../icons";
import { errorText, useStore, type CustomizeView } from "../store";
import { AddConnector } from "./AddConnector";
import { EditConnector } from "./EditConnector";
import { catalogDir, ConnectorPage, SkillPage } from "./Details";
import { DiscoverConnectors, DiscoverSkills, MyConnectors, MySkills, type Actions } from "./Lists";
import { brokenSkills, catalogServer, fromRepo, nextInLine, type SkillItem } from "./model";
import { PopMenu } from "./parts";
import { BrokenSkills, UploadSkill } from "./UploadSkill";
import { pageCwd, useCustomize } from "./useCustomize";
import "../styles/customize.css";

// 自定义 (docs/desktop/customize-design.md §10): skills and connectors, the person's own (我的)
// and the catalog's (发现), each card opening a page of its own. finx manages them; this page
// shows what it says and asks it for changes.

type Sheet = { kind: "upload" } | { kind: "add" } | { kind: "connector"; edit: McpServerView } | { kind: "broken" };

export function Customize() {
  const st = useStore();
  const { t } = useTranslation("customize");
  const recent = useMemo(() => recentProjects(st.sessions.filter((s) => !s.archived)), [st.sessions]);
  const cwd = pageCwd(st, recent);
  const project = cwd ? (projectNames([cwd]).get(cwd) ?? cwd) : null;
  const c = useCustomize(cwd);
  const v = st.customize;
  const latest = useRef(st);
  latest.current = st;
  const setView = useCallback((patch: Partial<CustomizeView>) => {
    const s = latest.current;
    s.set({ customize: { ...s.customize, ...patch } });
  }, []);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [addAt, setAddAt] = useState<DOMRect | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  // The list's place, kept while a card's page is open.
  const listTop = useRef(0);
  const restore = useRef<number | null>(null);

  const open = useCallback(
    (detail: NonNullable<CustomizeView["detail"]>) => {
      if (!latest.current.customize.detail) listTop.current = scroller.current?.scrollTop ?? 0;
      setView({ detail });
      scroller.current?.scrollTo(0, 0);
    },
    [setView],
  );
  const back = useCallback(() => {
    restore.current = listTop.current;
    setView({ detail: null });
  }, [setView]);
  useLayoutEffect(() => {
    if (v.detail || restore.current === null) return;
    scroller.current?.scrollTo(0, restore.current);
    restore.current = null;
  }, [v.detail]);
  // Esc on a card's page goes back to the list (a menu or a sheet takes it first).
  useEffect(() => {
    if (!v.detail) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open], .cz-menu") && back();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [v.detail, back]);
  const onScroll = () => {
    const b = bar.current;
    const box = scroller.current;
    if (b && box) setStuck(b.getBoundingClientRect().top <= box.getBoundingClientRect().top + 0.5 && box.scrollTop > 0);
  };

  const adding = (key: string, on: boolean) =>
    c.setAdding((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const a: Actions = {
    open,
    upload: () => setSheet({ kind: "upload" }),
    // A conversation without a project, the built-in skill already in the message (§10.4).
    create: () => st.set({ selection: { kind: "new" }, draft: { ...st.draft, cwd: null, noProject: true }, prefill: "/skill:skill-creator " }),
    useSkill: (name) => st.set({ selection: { kind: "new" }, prefill: `/skill:${name} ` }),
    addCustom: () => setSheet({ kind: "add" }),
    edit: (s) => setSheet({ kind: "connector", edit: s }),
    showBroken: () => setSheet({ kind: "broken" }),
    discover: () => setView({ view: "discover" }),
    installSkill: (cat: CatalogSkill) => {
      if (!st.rpc) return;
      adding(`skill:${cat.id}`, true);
      st.rpc
        .request("skills/install", { from: `${catalogDir()}/${cat.id}`, scope: "user", source: { kind: "catalog", id: cat.id, version: cat.version } })
        .then(async (r) => {
          await c.readSkills();
          st.show(t("toast.skillAdded", { name: r.skill.name }));
        })
        .catch((e) => st.show(errorText(e), undefined, true))
        .finally(() => adding(`skill:${cat.id}`, false));
    },
    // A connector that needs a token is added from its page, where the token is asked for.
    addConnector: (cat: CatalogConnector, layer: ConfigLayer = "user", token?: string) => {
      if (cat.install.auth.kind === "token" && !token) return open({ kind: "connector", id: cat.id, catalog: true, tab: "overview" });
      const { server, secrets } = catalogServer(cat, token ?? null);
      adding(`server:${cat.id}`, true);
      c.saveServer(layer, cat.id, server, secrets)
        .then(({ check }) => {
          if (check?.server.status.state === "ok") st.show(t("toast.serverAdded", { name: cat.name, count: check.tools.length }));
          else st.show(t("toast.serverAddedFailed", { name: cat.name, error: check?.server.status.error ?? "" }), undefined, true);
        })
        .catch((e) => st.show(errorText(e), undefined, true))
        .finally(() => adding(`server:${cat.id}`, false));
    },
    toggleSkill: (item: SkillItem, on: boolean) => {
      const next = on ? null : nextInLine(c.skills, item);
      const done = on
        ? t(item.offByDefault ? "toast.skillOnRepo" : "toast.skillOn", { name: item.entry.name })
        : next
          ? t("toast.skillOffNext", { name: item.entry.name })
          : item.group === "project"
            ? t("toast.skillOffRepo", { name: item.entry.name })
            : t("toast.skillOff", { name: item.entry.name });
      void c.switchSkill(item, on, done);
    },
    toggleServer: (s: McpServerView, on: boolean) => {
      const done = fromRepo(s)
        ? t(on ? "toast.serverOnForYou" : "toast.serverOffForYou", { name: s.name })
        : t(on ? "toast.serverOn" : "toast.serverOff", { name: s.name });
      void c.switchServer(s, on, done);
    },
  };

  const addMenu = [
    { header: t("add.skills") },
    { id: "upload", label: t("add.upload"), desc: t("add.uploadDesc"), icon: "upload", run: a.upload },
    { id: "create", label: t("add.create"), desc: t("add.createDesc"), icon: "chat", run: a.create },
    null,
    { header: t("add.connectors") },
    { id: "custom", label: t("add.custom"), desc: t("add.customDesc"), icon: "plug", run: a.addCustom },
  ];

  let body;
  if (!st.rpc || (!c.loaded && !c.failed)) {
    body = (
      <div className="cz-wait">
        <span className="mini-spin" />
        {t("loading")}
      </div>
    );
  } else if (c.failed && !c.loaded) {
    body = (
      <div className="cz-wait">
        {t("failed", { error: c.failed })}{" "}
        <button className="link" onClick={() => void c.readAll()}>
          {t("retry")}
        </button>
      </div>
    );
  } else if (v.tab === "skills") {
    body = v.view === "mine" ? <MySkills c={c} a={a} project={project} /> : <DiscoverSkills c={c} a={a} />;
  } else {
    body = v.view === "mine" ? <MyConnectors c={c} a={a} project={project} /> : <DiscoverConnectors c={c} a={a} />;
  }

  const detail = v.detail;
  const onTab = (tab: string) => detail && setView({ detail: { ...detail, tab } });
  return (
    <>
      <div className="ctool drag">
        <SidebarToggle />
        <div className="ctitle" />
      </div>
      <div className="cscroll cz" ref={scroller} onScroll={onScroll}>
        <div className="dbody cz-body">
          {detail && c.loaded ? (
            detail.kind === "skill" ? (
              <SkillPage key={detail.id} c={c} a={a} detail={detail} project={project} onBack={back} onTab={onTab} />
            ) : (
              <ConnectorPage key={detail.id} c={c} a={a} detail={detail} project={project} onBack={back} onTab={onTab} />
            )
          ) : (
            <>
              <h1 className="cz-title">{t("title")}</h1>
              <div className={`cz-bar ${stuck ? "stuck" : ""}`} ref={bar}>
                <div className="cz-tabs" role="tablist">
                  {(["skills", "connectors"] as const).map((tab) => (
                    <button key={tab} role="tab" aria-selected={v.tab === tab} className={`cz-tab ${v.tab === tab ? "on" : ""}`} onClick={() => setView({ tab, detail: null })}>
                      {t(`tab.${tab}`)}
                    </button>
                  ))}
                </div>
                <div className="cz-vsep" />
                <div className="seg cz-seg">
                  {(["mine", "discover"] as const).map((view) => (
                    <button key={view} className={v.view === view ? "on" : ""} aria-pressed={v.view === view} onClick={() => setView({ view, detail: null })}>
                      {t(`view.${view}`)}
                    </button>
                  ))}
                </div>
                <div className="grow" />
                <button
                  className="btn cz-solid cz-addbtn"
                  aria-haspopup="menu"
                  aria-expanded={!!addAt}
                  onClick={(e) => setAddAt(addAt ? null : e.currentTarget.getBoundingClientRect())}
                >
                  <Icon name="plus" />
                  {t("add.button")}
                  <Icon name="chevD" className="chev" />
                </button>
              </div>
              {body}
            </>
          )}
        </div>
      </div>
      {addAt && <PopMenu anchor={addAt} items={addMenu} label={t("add.button")} onClose={() => setAddAt(null)} />}
      {sheet?.kind === "upload" && <UploadSkill c={c} onClose={() => setSheet(null)} onAdded={() => setView({ tab: "skills", view: "mine", detail: null })} />}
      {sheet?.kind === "add" && (
        <AddConnector
          c={c}
          project={project}
          onClose={() => setSheet(null)}
          onAdded={() => setView({ tab: "connectors", view: "mine", detail: null })}
          onOpen={(name) => (setSheet(null), setView({ tab: "connectors", view: "mine", detail: { kind: "connector", id: name, tab: "overview" } }))}
        />
      )}
      {sheet?.kind === "connector" && (
        <EditConnector
          c={c}
          server={sheet.edit}
          project={project}
          onClose={() => setSheet(null)}
          onSaved={(name) => setView({ tab: "connectors", view: "mine", detail: { kind: "connector", id: name, tab: "overview" } })}
        />
      )}
      {sheet?.kind === "broken" && <BrokenSkills broken={brokenSkills(c.skills)} onClose={() => setSheet(null)} />}
    </>
  );
}
