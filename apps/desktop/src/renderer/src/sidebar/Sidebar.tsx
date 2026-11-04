import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  clockText, displayTitle, elapsedSeconds, inTask, needsAttention, projectNames, projectsOf, sectionCounted, sections, stateOf, updatedAt,
  type ListSession, type ListView, type Section,
} from "@finx/client";
import { archive, confirmDelete, isArchivable, rename, sessionMenu, unarchive } from "../actions";
import { RenameField, StatusDot } from "../components";
import { bucketTitle, listTime } from "../format";
import { Icon } from "../icons";
import { setSidebar } from "../layout";
import { keptView } from "../session/useSession";
import { useNow, useStore, type Store } from "../store";
import { UpdateReminder } from "../updates";
import { FootMenu } from "./FootMenu";

/** The list as the sidebar shows it, in the owner's view. */
export function listSections(st: Store, now: Date): Section[] {
  return sections(st.sessions, st.view, { archived: st.archived, now });
}

export function Sidebar() {
  const st = useStore();
  const { t } = useTranslation("common");
  const now = useNow(30_000);
  const secs = listSections(st, now);
  const projects = useMemo(() => projectsOf(st.sessions), [st.sessions]);
  const names = useMemo(() => projectNames(projects), [projects]);
  // Read again when a session's last activity moves (a task may have switched branches).
  const branches = useBranches(projects, st.sessions.reduce((n, s) => Math.max(n, updatedAt(s)), 0));
  const total = secs.reduce((n, x) => n + x.sessions.length, 0);
  // The rows get the store as of a click, so a change elsewhere doesn't render them again.
  const latest = useRef(st);
  latest.current = st;
  const title = (sec: Section) =>
    sec.grouping === "project" ? (sec.key === "" ? t("sidebar.noProject") : (names.get(sec.key) ?? sec.key)) : bucketTitle(sec.key as Parameters<typeof bucketTitle>[0]);
  const byProject = st.view.group === "project";
  // The list's own heading collapses every group, or opens them all once every one is shut.
  const ids = secs.map((sec) => `${sec.grouping}:${sec.key}`);
  const allShut = ids.length > 0 && ids.every((id) => st.collapsed.includes(id));
  return (
    <aside className="side" aria-label={t("sidebar.label")}>
      <div className="side-top drag">
        <button className="tb" onClick={() => setSidebar(st, false)} title={t("window.hideSidebar")} aria-label={t("window.hideSidebar")}>
          <Icon name="sidebar" />
        </button>
      </div>
      <nav className="side-nav">
        <button className={`nav-i ${st.selection.kind === "new" ? "sel" : ""}`} onClick={() => st.set({ selection: { kind: "new" } })}>
          <Icon name="plus" />
          <span>{t("sidebar.newSession")}</span>
          <span className="kbd">⌘N</span>
        </button>
        <button className="nav-i" onClick={() => st.set({ searching: true })}>
          <Icon name="search" />
          <span>{t("sidebar.search")}</span>
          <span className="kbd">⌘K</span>
        </button>
        <button className={`nav-i ${st.selection.kind === "customize" ? "sel" : ""}`} onClick={() => st.set({ selection: { kind: "customize" } })}>
          <Icon name="blocks" />
          <span>{t("sidebar.customize")}</span>
        </button>
      </nav>
      <div className="side-lh">
        <button
          className={`side-lh-t ${allShut ? "shut" : ""}`}
          title={allShut ? t("sidebar.expandAll") : t("sidebar.collapseAll")}
          aria-expanded={!allShut}
          disabled={ids.length === 0}
          onClick={() => st.set({ collapsed: allShut ? st.collapsed.filter((c) => !ids.includes(c)) : [...new Set([...st.collapsed, ...ids])] })}
        >
          <span>{byProject ? t("sidebar.projects") : t("sidebar.sessions")}</span>
          <Icon name="caret" className="sm" />
        </button>
        <ListViewMenu />
      </div>
      <div className={`side-list ${byProject ? "by-project" : ""}`} role="list" aria-label={t("sidebar.sessions")}>
        {secs.map((sec) => {
          const id = `${sec.grouping}:${sec.key}`;
          const open = !st.collapsed.includes(id);
          return (
            <div key={id} role="group" aria-label={title(sec)}>
              <div className="grp-row">
                <button
                  className={`grp-h ${open ? "" : "shut"}`}
                  aria-expanded={open}
                  title={sec.grouping === "project" && sec.key ? sec.key : undefined}
                  onClick={() => st.set({ collapsed: open ? [...st.collapsed, id] : st.collapsed.filter((c) => c !== id) })}
                >
                  {sec.grouping === "project" && <Icon name="folder" className="gi" />}
                  <span className="gt">{title(sec)}</span>
                  {sectionCounted(sec) && <span className="n">{sec.sessions.length}</span>}
                  <Icon name="caret" className="sm" />
                </button>
                {/* A project's heading starts a new session in that project; that of the sessions without one, another without one. */}
                {sec.grouping === "project" && (
                  <button
                    className="tb grpact"
                    title={sec.key ? t("sidebar.newSessionIn", { project: title(sec) }) : t("sidebar.newSessionNoProject")}
                    aria-label={sec.key ? t("sidebar.newSessionIn", { project: title(sec) }) : t("sidebar.newSessionNoProject")}
                    onClick={() => st.set({ selection: { kind: "new" }, draft: { ...st.draft, cwd: sec.key || null, noProject: !sec.key } })}
                  >
                    <Icon name="plus" />
                  </button>
                )}
              </div>
              {open &&
                sec.sessions.map((s) => (
                  <SessionRow
                    key={s.session_id}
                    s={s}
                    sel={st.selection.kind === "session" && st.selection.id === s.session_id}
                    project={s.no_project ? null : (names.get(s.cwd) ?? s.cwd)}
                    branch={s.no_project ? undefined : branches.get(s.cwd)}
                    meta={st.view.metadata}
                    grouping={st.view.group}
                    renaming={st.renaming === s.session_id}
                    store={latest}
                  />
                ))}
            </div>
          );
        })}
        {!st.loaded ? (
          st.kernel === "down" ? (
            <div className="endrow" style={{ paddingTop: 30 }}>
              {t("kernel.down")}
              {st.status?.reason && <div className="kfail">{st.status.reason}</div>}
              {st.status?.output && <pre className="kfail-out">{st.status.output}</pre>}
              <div style={{ marginTop: 8, display: "flex", gap: 12, justifyContent: "center" }}>
                <button className="link" onClick={() => window.finx?.retryKernel()}>{t("kernel.retry")}</button>
                {st.status?.log && <button className="link" onClick={() => window.finx?.revealPath(st.status!.log)}>{t("kernel.showLog")}</button>}
              </div>
            </div>
          ) : (
            <div className="loadrow">
              <span className="mini-spin" />
              {st.status?.state === "starting" ? t("kernel.starting") : t("sidebar.loading")}
            </div>
          )
        ) : total === 0 ? (
          <div className="endrow" style={{ paddingTop: 30 }}>
            <Trans t={t} i18nKey="sidebar.empty" components={{ br: <br /> }} />
            {st.sessions.some((s) => s.archived) && !st.archived && (
              <div style={{ marginTop: 8 }}>
                <button className="link" onClick={() => st.set({ archived: true })}>{t("sidebar.showArchived")}</button>
              </div>
            )}
          </div>
        ) : null}
      </div>
      <UpdateReminder />
      <FootMenu />
    </aside>
  );
}

const SessionRow = memo(function SessionRow({ s, sel, project, branch, meta, grouping, renaming, store }: {
  s: ListSession; sel: boolean; project: string | null; branch: string | null | undefined; meta: boolean; grouping: ListView["group"]; renaming: boolean; store: RefObject<Store>;
}) {
  const { t } = useTranslation("common");
  // Where the ⋯ menu opens (under its button), while it is open.
  const [menu, setMenu] = useState<{ x: number; y: number; key: boolean } | null>(null);
  const running = inTask(s);
  const title = displayTitle(s) || t("sidebar.untitled");
  // Grouped by project, the project is the heading: the row's line says the branch only.
  const where = grouping === "project" ? null : (project ?? t("sidebar.noProject"));
  return (
    <div
      className={`srow has-act ${sel ? "sel" : ""} ${menu ? "menu-open" : ""} ${s.archived ? "arch" : ""}`}
      role="listitem"
      aria-current={sel || undefined}
      tabIndex={0}
      onClick={() => !renaming && store.current.select(s.session_id)}
      onKeyDown={(e) => !renaming && e.key === "Enter" && store.current.select(s.session_id)}
      onDoubleClick={(e) => !renaming && !(e.target as Element).closest(".rowact, .vmenu") && store.current.set({ renaming: s.session_id })}
      onContextMenu={(e) => {
        e.preventDefault();
        sessionMenu(store.current, s, keptView(s.session_id)?.info.session_file);
      }}
    >
      <div className="smain">
        <div className="sl1">
          {/* While a task is on, the title shimmers (waiting for an approval adds a dot); a failed session has a dot only, an idle or archived one neither. */}
          {renaming ? (
            <RenameField
              s={s}
              className="srename"
              end={(title) => {
                const st = store.current;
                st.set({ renaming: null });
                if (title !== null) rename(st, s, title);
              }}
            />
          ) : (
            <span className={`stitle ${running ? "run" : ""}`} title={title}>
              {title}
              {running && (
                <>
                  <span className="shine" data-t={title} aria-hidden="true" />
                  <span className="shine band" data-t={title} aria-hidden="true" />
                </>
              )}
            </span>
          )}
          <span className="smeta">
            {needsAttention(s) && <StatusDot state={stateOf(s)} />}
          </span>
          <button
            className="rowact"
            title={t("sessionMenu.more")}
            aria-label={t("sessionMenu.more")}
            aria-haspopup="menu"
            aria-expanded={!!menu}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setMenu(menu ? null : { x: r.right, y: r.bottom + 4, key: e.detail === 0 });
            }}
          >
            <Icon name="more" className="sm" />
          </button>
          {menu && <RowMenu s={s} at={menu} store={store} onClose={() => setMenu(null)} />}
        </div>
        {meta && (
          <div className="sl2">
            <span className="sl2t">
              {where && (
                <span className="sl2i" title={project ? s.cwd : undefined}>
                  <Icon name="folder" />
                  <span>{where}</span>
                </span>
              )}
              {branch && (
                <span className="sl2i" title={branch}>
                  <Icon name="branch" />
                  <span>{branch}</span>
                </span>
              )}
            </span>
            <RowTime s={s} />
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * A row's ⋯ menu: rename, archive (or unarchive), and delete after a
 * separator. Right-aligned under its button; clicks stay in the menu, not the row.
 */
function RowMenu({ s, at, store, onClose }: { s: ListSession; at: { x: number; y: number; key: boolean }; store: RefObject<Store>; onClose: () => void }) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: at.y });
  const items: ({ id: string; label: string; run: () => void; disabled?: boolean; danger?: boolean } | null)[] = [
    { id: "rename", label: t("sessionMenu.rename"), run: () => store.current.set({ renaming: s.session_id }) },
    s.archived
      ? { id: "unarchive", label: t("sessionMenu.unarchive"), run: () => unarchive(store.current, s) }
      : { id: "archive", label: t("sessionMenu.archive"), run: () => archive(store.current, s), disabled: !isArchivable(s) },
    null,
    { id: "delete", label: t("sessionMenu.delete"), run: () => confirmDelete(store.current, s), danger: true },
  ];
  useLayoutEffect(() => {
    const el = ref.current!;
    const top = at.y + el.offsetHeight > innerHeight - 8 ? at.y - el.offsetHeight - 30 : at.y;
    setPos({ left: Math.max(8, at.x - el.offsetWidth), top });
    (at.key ? el.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)") : el)?.focus();
  }, [at]);
  useEffect(() => {
    // Its own button toggles it (on click), so a press there isn't outside.
    const outside = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".rowact[aria-expanded=true]") && onClose();
    document.addEventListener("mousedown", outside);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return (
    <div
      className="vmenu"
      role="menu"
      aria-label={t("sessionMenu.more")}
      tabIndex={-1}
      ref={ref}
      style={pos}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => menuKeys(e, ref.current, onClose)}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it ? (
          <button key={it.id} className={`mi ${it.danger ? "danger" : ""}`} role="menuitem" tabIndex={-1} disabled={it.disabled} onMouseMove={(e) => e.currentTarget.focus()} onClick={() => (onClose(), it.run())}>
            {it.label}
          </button>
        ) : (
          <div key={i} className="msep" role="separator" />
        ),
      )}
    </div>
  );
}

/** The keyboard in a page-drawn menu, as in a native one: arrows move, Esc and Tab close. */
export function menuKeys(e: ReactKeyboardEvent, box: HTMLElement | null, close: () => void) {
  e.stopPropagation();
  // The menu's own items, not those of a submenu open inside it.
  const all = [...(box?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? [])].filter((el) => el.parentElement?.closest("[role=menu]") === box);
  const i = all.indexOf(document.activeElement as HTMLElement);
  const go = { ArrowDown: (i + 1) % all.length, ArrowUp: i <= 0 ? all.length - 1 : i - 1, Home: 0, End: all.length - 1 }[e.key];
  if (go !== undefined) {
    e.preventDefault();
    all[go]?.focus();
  } else if (e.key === "Escape" || e.key === "Tab") {
    e.preventDefault();
    close();
  }
}

/** The second line's right end: how long the running task has run, else when the session last changed. */
function RowTime({ s }: { s: ListSession }) {
  const running = inTask(s);
  const now = useNow(running ? 1000 : 30_000);
  const started = s.task_started_at ? Date.parse(s.task_started_at) : NaN;
  const text = running && !Number.isNaN(started) ? clockText(elapsedSeconds(started, now.getTime())) : listTime(new Date(updatedAt(s)), now);
  return <span className="stime">{text}</span>;
}

type ViewPane = "group" | "sort" | "show";
/** A change to the list's view, or to whether it shows archived sessions. */
type ViewPatch = Partial<ListView> & { archived?: boolean };
type ViewChoice = { label: string; on: boolean; role: "menuitemradio" | "menuitemcheckbox"; patch: ViewPatch } | null;

/**
 * The list's view menu: grouping, sorting by last activity and whether rows
 * show their metadata, each a submenu. Drawn like the foot menu but opaque,
 * over the list; the keyboard works as in a native menu (→ opens a submenu,
 * ← and Esc go back). Rows follow the mouse only as it moves, so a menu
 * opening under a resting pointer keeps the keyboard's choice.
 */
function ListViewMenu() {
  const st = useStore();
  const { t } = useTranslation("common");
  const v = st.view;
  const [open, setOpen] = useState<false | "mouse" | "key">(false);
  const [pane, setPane] = useState<{ id: ViewPane; key: boolean } | null>(null);
  const [at, setAt] = useState({ x: 0, y: 0, sx: 0, sy: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const close = (back: boolean) => {
    setOpen(false);
    setPane(null);
    if (back) btn.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    (open === "key" ? menu.current?.querySelector<HTMLElement>("[role=menuitem]") : menu.current)?.focus();
    const outside = (e: MouseEvent) => ![btn, menu, sub].some((r) => r.current?.contains(e.target as Node)) && close(false);
    const blur = () => close(false);
    document.addEventListener("mousedown", outside);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("blur", blur);
    };
  }, [open]);
  // The submenu beside its row, on the left when there's no room on the right; from the keyboard its first item takes focus.
  useLayoutEffect(() => {
    if (!pane || !menu.current || !sub.current) return;
    const m = menu.current.getBoundingClientRect();
    const r = menu.current.querySelector(`[data-pane=${pane.id}]`)!.getBoundingClientRect();
    const w = sub.current.offsetWidth;
    setAt((a) => ({ ...a, sx: m.right + w + 4 > innerWidth ? m.left - w - 2 : m.right + 2, sy: r.top - 5 }));
    if (pane.key) sub.current.querySelector<HTMLElement>("[role^=menuitem]")?.focus();
  }, [pane]);
  const toggle = (e: { detail: number }) => {
    if (open) return close(false);
    const r = btn.current!.getBoundingClientRect();
    // Right-aligned to the button, so it opens leftward, over the sidebar.
    setAt({ x: innerWidth - r.right, y: r.bottom + 4, sx: 0, sy: 0 });
    setOpen(e.detail ? "mouse" : "key");
  };
  const choose = ({ archived, ...patch }: ViewPatch) => {
    st.set({ view: { ...v, ...patch }, ...(archived === undefined ? {} : { archived }) });
    close(true);
  };
  const groups: Record<ListView["group"], string> = { status: t("listView.byStatus"), date: t("listView.byDate"), project: t("listView.byProject") };
  const panes: { id: ViewPane; label: string; value: string }[] = [
    { id: "group", label: t("listView.group"), value: groups[v.group] },
    { id: "sort", label: t("listView.sort"), value: t(v.newestFirst ? "listView.newestFirst" : "listView.oldestFirst") },
    { id: "show", label: t("listView.show"), value: t(v.metadata ? "listView.metadata" : "listView.titleOnly") },
  ];
  const choices: Record<ViewPane, ViewChoice[]> = {
    group: (Object.keys(groups) as ListView["group"][]).map((g) => ({ label: groups[g], on: v.group === g, role: "menuitemradio", patch: { group: g } })),
    sort: [
      { label: t("listView.lastActive"), on: true, role: "menuitemradio", patch: {} },
      null,
      { label: t("listView.newestFirst"), on: v.newestFirst, role: "menuitemradio", patch: { newestFirst: true } },
      { label: t("listView.oldestFirst"), on: !v.newestFirst, role: "menuitemradio", patch: { newestFirst: false } },
    ],
    show: [
      { label: t("listView.metadata"), on: v.metadata, role: "menuitemcheckbox", patch: { metadata: !v.metadata } },
      { label: t("sidebar.showArchived"), on: st.archived, role: "menuitemcheckbox", patch: { archived: !st.archived } },
    ],
  };
  const move = (e: ReactKeyboardEvent, box: HTMLElement | null) => {
    const all = [...(box?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    const go = { ArrowDown: (i + 1) % all.length, ArrowUp: i <= 0 ? all.length - 1 : i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (go === undefined) return false;
    e.preventDefault();
    all[go]?.focus();
    return true;
  };
  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (move(e, menu.current)) return setPane(null);
    const id = (document.activeElement as HTMLElement | null)?.dataset.pane as ViewPane | undefined;
    if (id && (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setPane({ id, key: true });
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };
  const onSubKey = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    if (move(e, sub.current)) return;
    if (e.key === "ArrowLeft" || e.key === "Escape") {
      e.preventDefault();
      const id = pane?.id;
      setPane(null);
      menu.current?.querySelector<HTMLElement>(`[data-pane=${id}]`)?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      close(true);
    }
  };
  return (
    <>
      <button ref={btn} className={`tb ${open ? "on" : ""}`} title={t("listView.title")} aria-label={t("listView.title")} aria-haspopup="menu" aria-expanded={!!open} onClick={toggle}>
        <Icon name="filter" />
      </button>
      {open && (
        <div className="vmenu" role="menu" aria-label={t("listView.title")} tabIndex={-1} ref={menu} style={{ right: at.x, top: at.y }} onKeyDown={onMenuKey}>
          {panes.map((p) => (
            <button
              key={p.id}
              className={`mi ${pane?.id === p.id ? "open" : ""}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={pane?.id === p.id}
              tabIndex={-1}
              data-pane={p.id}
              onMouseMove={(e) => document.activeElement !== e.currentTarget && (e.currentTarget.focus(), setPane({ id: p.id, key: false }))}
              onClick={() => setPane({ id: p.id, key: false })}
            >
              <span>{p.label}</span>
              <span className="val">{p.value}</span>
              <Icon name="chevR" className="sm" />
            </button>
          ))}
        </div>
      )}
      {open && pane && (
        <div className="vmenu" role="menu" aria-label={panes.find((p) => p.id === pane.id)!.label} tabIndex={-1} ref={sub} style={{ left: at.sx, top: at.sy }} onKeyDown={onSubKey}>
          {choices[pane.id].map((c, i) =>
            c ? (
              <button key={c.label} className="mi" role={c.role} aria-checked={c.on} tabIndex={-1} onMouseMove={(e) => e.currentTarget.focus()} onClick={() => choose(c.patch)}>
                <span className="ck">{c.on && <Icon name="check" className="sm" />}</span>
                <span>{c.label}</span>
              </button>
            ) : (
              <div key={i} className="msep" role="separator" />
            ),
          )}
        </div>
      )}
    </>
  );
}

/**
 * The git branch checked out in each project, read again whenever `tick` changes or the window
 * gains focus; null outside a repository, absent until read.
 */
function useBranches(cwds: string[], tick: number): Map<string, string | null> {
  const [branches, setBranches] = useState(() => new Map<string, string | null>());
  const key = cwds.join("\n");
  useEffect(() => {
    if (!window.finx) return;
    let current = true;
    const read = () =>
      void Promise.all(cwds.map(async (c) => [c, await window.finx!.gitBranch(c)] as const)).then((found) => {
        if (!current) return;
        // The same branches keep the same map, so the rows stay as they are.
        setBranches((was) => (found.length === was.size && found.every(([c, b]) => was.get(c) === b) ? was : new Map(found)));
      });
    read();
    window.addEventListener("focus", read);
    return () => {
      current = false;
      window.removeEventListener("focus", read);
    };
    // `cwds` is described by `key`.
  }, [key, tick]);
  return branches;
}
