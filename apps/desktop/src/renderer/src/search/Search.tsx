import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { botLine, displayTitle, projectNames, projectsOf, rowModel, searchBots, searchFilter, searchSessions, stateOf, updatedAt, type SearchFilter } from "@finx/client";
import { BotAvatar } from "../bots/Avatar";
import { i18n } from "../../../shared/i18n";
import { StatusDot } from "../components";
import { modelTitle, shortTime } from "../format";
import { Icon } from "../icons";
import { useOverlay } from "../overlays";
import { useStore, type Store } from "../store";

type Action = { label: string; shortcut: string; run: (st: Store) => void };

const actions = (): Action[] => [
  { label: i18n.t("common:search.newSession"), shortcut: "⌘N", run: (st) => st.set({ selection: { kind: "new" } }) },
  { label: i18n.t("common:search.openSettings"), shortcut: "⌘,", run: () => window.finx?.openSettings() },
];

/** The ⌘K search palette of the mode the window is in: sessions, or bots (bot-mode-design §6.19). */
export function SearchPalette() {
  const st = useStore();
  return st.mode === "bots" ? <BotSearch /> : <SessionSearch />;
}

// Find a session by its title, first message, project or model, narrowed by
// its filters; or run an action.
function SessionSearch() {
  useOverlay();
  const st = useStore();
  const { t } = useTranslation("common");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SearchFilter>(() => searchFilter());
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const names = projectNames(projectsOf(st.sessions));
  const found = searchSessions(st.sessions, query, filter);
  const sessions = found.slice(0, 8);
  const q = query.trim().toLowerCase();
  const acts = actions().filter((a) => q === "" || a.label.toLowerCase().includes(q));
  const count = sessions.length + acts.length;

  const close = () => st.set({ searching: false });
  const open = (i: number) => {
    const s = sessions[i];
    if (s) {
      // An archived session shows in the list only with archived ones.
      if (s.archived) st.set({ archived: true });
      close();
      st.select(s.session_id);
      return;
    }
    const a = acts[i - sessions.length];
    if (a) {
      close();
      a.run(st);
    }
  };
  // The palette has the keyboard while it is open (but not while an input
  // method composes), from the frame it first shows in: an Escape pressed
  // at once closes it.
  useLayoutEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") setIndex(Math.max(0, Math.min(count - 1, index + (e.key === "ArrowDown" ? 1 : -1))));
      else if (e.key === "Enter") open(index);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  });
  useEffect(() => {
    list.current?.querySelector(".pr.on")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const change = (patch: Partial<SearchFilter>) => {
    setFilter({ ...filter, ...patch });
    setIndex(0);
  };
  const picker = (key: "project" | "model", label: string, options: [string, string][]) => (
    <select className={filter[key] ? "on" : ""} aria-label={label} value={filter[key]} onChange={(e) => change({ [key]: e.target.value })}>
      <option value="">{t("search.all", { label })}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  );
  const projects = [...names].sort((a, b) => a[1].localeCompare(b[1]));
  const models = [...new Set(st.sessions.flatMap((s) => (s.model ? [s.model] : [])))].sort().map((m): [string, string] => [m, modelTitle(m, st.models)]);
  const now = new Date();

  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="pal" role="dialog" aria-label={t("search.title")}>
        <div className="pal-in">
          <Icon name="search" />
          <input
            autoFocus
            placeholder={t("search.placeholder")}
            aria-label={t("search.title")}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="pal-f">
          {picker("project", t("filter.project"), projects)}
          {picker("model", t("filter.model"), models)}
          <button className={`cb ${filter.archived ? "on" : ""}`} role="checkbox" aria-checked={filter.archived} style={{ marginLeft: 6, fontSize: 12 }} onClick={() => change({ archived: !filter.archived })}>
            <span className="box"><Icon name="check" /></span>
            {t("search.includeArchived")}
          </button>
        </div>
        <div className="pal-r" ref={list} role="listbox" aria-label={t("search.results")}>
          {sessions.length > 0 ? (
            <div className="pal-h">{t("search.found", { n: found.length })}</div>
          ) : (
            <>
              <div className="pal-h">{t("search.none")}</div>
              <div className="muted" style={{ padding: "4px 10px 10px", fontSize: 12 }}>{t("search.noneHint")}</div>
            </>
          )}
          {sessions.map((s, i) => (
            <Row key={s.session_id} on={i === index} onPick={() => open(i)} onHover={() => setIndex(i)}>
              <StatusDot state={stateOf(s)} />
              <span className="t">{displayTitle(s) || t("sidebar.untitled")}</span>
              <span className="muted">
                {[s.no_project ? t("sidebar.noProject") : names.get(s.cwd), rowModel(s), s.archived ? t("search.archived") : shortTime(new Date(updatedAt(s)), now)].filter(Boolean).join(" · ")}
              </span>
            </Row>
          ))}
          {acts.length > 0 && <div className="pal-h">{t("search.actions")}</div>}
          {acts.map((a, j) => {
            const i = sessions.length + j;
            return (
              <Row key={a.label} on={i === index} onPick={() => open(i)} onHover={() => setIndex(i)}>
                <Icon name="bolt" className="sm" />
                <span className="t">{a.label}</span>
                <span className="kbd">{a.shortcut}</span>
              </Row>
            );
          })}
        </div>
        <div className="pal-foot">
          <span>{t("search.select")}</span>
          <span>{t("search.open")}</span>
        </div>
      </div>
    </>
  );
}

/** Bot mode's palette: a bot by its name or what was last said; or make one. */
function BotSearch() {
  useOverlay();
  const st = useStore();
  const { t } = useTranslation("common");
  const { t: tb } = useTranslation("bots");
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const found = searchBots(st.bots, query);
  const bots = found.slice(0, 8);
  const q = query.trim().toLowerCase();
  const acts: Action[] = [
    { label: tb("nav.newBot"), shortcut: "⌘N", run: (s: Store) => s.set({ botSheet: { kind: "new" } }) },
    { label: t("search.openSettings"), shortcut: "⌘,", run: () => window.finx?.openSettings() },
  ].filter((a) => q === "" || a.label.toLowerCase().includes(q));
  const count = bots.length + acts.length;
  const close = () => st.set({ searching: false });
  const open = (i: number) => {
    const b = bots[i];
    close();
    if (b) return st.selectBot(b.id);
    acts[i - bots.length]?.run(st);
  };
  useLayoutEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") setIndex(Math.max(0, Math.min(count - 1, index + (e.key === "ArrowDown" ? 1 : -1))));
      else if (e.key === "Enter") open(index);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  });
  useEffect(() => {
    list.current?.querySelector(".pr.on")?.scrollIntoView({ block: "nearest" });
  }, [index]);
  const now = new Date();
  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="pal" role="dialog" aria-label={t("search.title")}>
        <div className="pal-in">
          <Icon name="search" />
          <input
            autoFocus
            placeholder={tb("search.placeholder")}
            aria-label={t("search.title")}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="pal-r" ref={list} role="listbox" aria-label={t("search.results")}>
          {bots.length > 0 ? (
            <div className="pal-h">{tb("search.found", { n: found.length })}</div>
          ) : (
            <>
              <div className="pal-h">{tb("search.none")}</div>
              <div className="muted" style={{ padding: "4px 10px 10px", fontSize: 12 }}>{tb("search.noneHint")}</div>
            </>
          )}
          {bots.map((b, i) => {
            const line = botLine(b);
            return (
              <Row key={b.id} on={i === index} onPick={() => open(i)} onHover={() => setIndex(i)}>
                <BotAvatar bot={b} size={22} />
                <span className="t">{b.name}</span>
                <span className="muted">{[line.kind === "last" ? line.text : "", b.last ? shortTime(new Date(b.last.ts), now) : ""].filter(Boolean).join(" · ")}</span>
              </Row>
            );
          })}
          {acts.length > 0 && <div className="pal-h">{t("search.actions")}</div>}
          {acts.map((a, j) => {
            const i = bots.length + j;
            return (
              <Row key={a.label} on={i === index} onPick={() => open(i)} onHover={() => setIndex(i)}>
                <Icon name="bolt" className="sm" />
                <span className="t">{a.label}</span>
                <span className="kbd">{a.shortcut}</span>
              </Row>
            );
          })}
        </div>
        <div className="pal-foot">
          <span>{t("search.select")}</span>
          <span>{t("search.open")}</span>
        </div>
      </div>
    </>
  );
}

function Row({ on, onPick, onHover, children }: { on: boolean; onPick: () => void; onHover: () => void; children: ReactNode }) {
  return (
    <button className={`pr ${on ? "on" : ""}`} role="option" aria-selected={on} tabIndex={-1} onClick={onPick} onMouseMove={on ? undefined : onHover}>
      {children}
    </button>
  );
}
