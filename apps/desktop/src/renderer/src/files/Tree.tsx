import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon } from "../icons";
import { useStore } from "../store";
import { fileMenu } from "../session/contentMenus";
import { joinPath, listDir, openFile, relativeTo, toggleDir, type SessionFiles } from "./state";

// The session's folder as a tree (file-panel-design §8): each folder read when it is opened,
// the rows to show worked out from what is open, and only the rows in sight drawn.

type Row = { path: string; name: string; dir: boolean; depth: number; parent: string };

const ROW = 26;

/** The rows the open folders show, in order. */
function rowsOf(s: SessionFiles): Row[] {
  const rows: Row[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of s.dirs.get(dir)?.list?.entries ?? []) {
      const path = joinPath(dir, e.name);
      rows.push({ path, name: e.name, dir: e.dir, depth, parent: dir });
      if (e.dir && s.expanded.has(path)) walk(path, depth + 1);
    }
  };
  walk(s.cwd, 0);
  return rows;
}

export function Tree({ s }: { s: SessionFiles }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => rowsOf(s), [s.rev]);
  const [focus, setFocus] = useState(0);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 8, getItemKey: (i) => rows[i]?.path ?? i });
  useEffect(() => void listDir(s, s.cwd), [s.session, s.cwd]);
  // The file in front, in sight.
  const active = s.active ? rows.findIndex((r) => r.path === s.active) : -1;
  useEffect(() => {
    if (active < 0) return;
    setFocus(active);
    v.scrollToIndex(active, { align: "auto" });
  }, [active, s.active]);

  const open = (r: Row) => (r.dir ? toggleDir(s, r.path) : openFile(s, r.path));
  const menu = (r: Row) => void fileMenu(st, { path: r.path, rel: relativeTo(s.cwd, r.path), kind: r.dir ? "folder" : "file" }, undefined);
  const move = (i: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, i));
    setFocus(next);
    v.scrollToIndex(next, { align: "auto" });
  };
  const root = s.dirs.get(s.cwd);

  return (
    <div
      className="fpt"
      ref={scroller}
      role="tree"
      aria-label={t("files.tree")}
      tabIndex={0}
      onKeyDown={(e) => {
        const r = rows[focus];
        if (e.key === "ArrowDown") move(focus + 1);
        else if (e.key === "ArrowUp") move(focus - 1);
        else if (e.key === "ArrowRight" && r?.dir && !s.expanded.has(r.path)) toggleDir(s, r.path);
        else if (e.key === "ArrowLeft" && r) {
          if (r.dir && s.expanded.has(r.path)) toggleDir(s, r.path);
          else move(rows.findIndex((x) => x.path === r.parent));
        } else if (e.key === "Enter" && r) open(r);
        else return;
        e.preventDefault();
      }}
    >
      {root?.error && <div className="fpt-note">{root.error}</div>}
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((item) => {
          const r = rows[item.index];
          if (!r) return null;
          const expanded = r.dir && s.expanded.has(r.path);
          return (
            <div
              key={item.key}
              role="treeitem"
              aria-level={r.depth + 1}
              aria-expanded={r.dir ? expanded : undefined}
              aria-selected={r.path === s.active}
              title={relativeTo(s.cwd, r.path) ?? r.path}
              className={`fpt-row ${r.path === s.active ? "on" : ""} ${item.index === focus ? "focus" : ""}`}
              style={{ transform: `translateY(${item.start}px)`, paddingLeft: 8 + r.depth * 14 }}
              onClick={() => {
                setFocus(item.index);
                open(r);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setFocus(item.index);
                menu(r);
              }}
            >
              {r.dir ? <Icon name="chevD" className={`chev ${expanded ? "open" : ""}`} /> : <span className="fpt-sp" />}
              <Icon name={r.dir ? "folder" : "file"} />
              <span className="fpt-name">{r.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
