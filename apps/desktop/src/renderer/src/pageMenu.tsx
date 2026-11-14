import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { MenuItem } from "../../shared/bridge";
import { Icon, type IconName } from "./icons";

// A menu at the pointer drawn by the page, in the app's own look (.pmenu), for the menus of what
// the conversation shows (content-actions-design §7): the same items a native menu takes, with
// submenus opening to the side. One at a time; it goes with a press elsewhere, Escape, a scroll,
// or the window losing focus.

type Open = { items: MenuItem[]; at: { x: number; y: number }; done: (id: string | null) => void };

let open: Open | null = null;
const watchers = new Set<() => void>();
const set = (next: Open | null) => {
  open = next;
  for (const w of watchers) w();
};

/** Where the pointer last pressed or asked for a menu: where the next menu opens. */
let pointer = { x: 0, y: 0 };
if (typeof document !== "undefined") {
  const at = (e: MouseEvent) => (pointer = { x: e.clientX, y: e.clientY });
  document.addEventListener("pointerdown", at, true);
  document.addEventListener("contextmenu", at, true);
}

/** Shows a menu at the pointer; resolves to the chosen item's id, or null when it is dismissed. */
export function pageMenu(items: MenuItem[]): Promise<string | null> {
  open?.done(null);
  return new Promise((resolve) => {
    const mine: Open = {
      items,
      at: pointer,
      done: (id) => {
        if (open === mine) set(null);
        resolve(id);
      },
    };
    set(mine);
    // End-to-end tests write the items down and may answer for the person (FINXWORK_E2E_MENU).
    void window.finx?.menuShown?.(items).then((id) => id && open === mine && mine.done(id), () => {});
  });
}

/** Icons for the items every menu of the conversation starts with, when all of a menu's items have one. */
const known: Record<string, IconName> = { copySel: "copy", quoteSel: "quote" };

type Row = Exclude<MenuItem, { separator: true }>;
const isRow = (it: MenuItem): it is Row => !("separator" in it);

/** The one menu open now; mounted once, in the main window. */
export function PageMenuHost() {
  const now = useSyncExternalStore(
    (w) => (watchers.add(w), () => void watchers.delete(w)),
    () => open,
  );
  useEffect(() => {
    if (!now) return;
    const close = () => now.done(null);
    const since = performance.now();
    // A press elsewhere, or a click that came with no press (a script's, assistive technology's); not the click that opened the menu.
    const down = (e: MouseEvent) => e.timeStamp > since && !(e.target as Element).closest?.(".pmenu") && close();
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), close());
    const wheel = (e: Event) => !(e.target as Element).closest?.(".pmenu") && close();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("click", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("wheel", wheel, { capture: true, passive: true });
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("click", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("wheel", wheel, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [now]);
  if (!now) return null;
  return createPortal(<List key={`${now.at.x}:${now.at.y}`} items={now.items} at={now.at} pick={now.done} root />, document.body);
}

function List({ items, at, pick, root, beside, back }: { items: MenuItem[]; at: { x: number; y: number }; pick: (id: string) => void; root?: boolean; /** The parent row's left edge, to open on that side when there is no room on the right. */ beside?: number; back?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [sub, setSub] = useState<{ i: number; x: number; y: number; left: number; keys: boolean } | null>(null);
  const icons = items.every((it) => !isRow(it) || !!it.icon || it.id in known);
  // Kept inside the window, as a native menu is.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = beside !== undefined && at.x + r.width > innerWidth - 6 ? beside - r.width - 2 : at.x;
    setPos({ x: Math.max(6, Math.min(x, innerWidth - r.width - 6)), y: Math.max(6, Math.min(at.y, innerHeight - r.height - 6)) });
    if (root || back) el.focus({ preventScroll: true });
  }, [at.x, at.y]);
  const rows = () => [...(box.current?.querySelectorAll<HTMLButtonElement>(":scope > .mi:not(:disabled)") ?? [])];
  const openSub = (el: HTMLElement, i: number, keys: boolean) => {
    const r = el.getBoundingClientRect();
    setSub({ i, x: r.right + 2, y: r.top - 5, left: r.left, keys });
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const list = rows();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      list[(i + (e.key === "ArrowDown" ? 1 : i < 0 ? 0 : -1) + list.length) % list.length]?.focus();
    } else if (e.key === "ArrowRight" && i >= 0 && list[i].getAttribute("aria-haspopup")) {
      e.preventDefault();
      e.stopPropagation();
      list[i].click();
    } else if (e.key === "ArrowLeft" && back) {
      e.preventDefault();
      e.stopPropagation();
      back();
    }
  };
  const child = sub && items[sub.i];
  return (
    <>
      {/* Pressing the menu keeps the selection it may act on. */}
      <div ref={box} className={`pmenu ${root ? "" : "sub"}`} role="menu" tabIndex={-1} style={{ left: pos?.x ?? at.x, top: pos?.y ?? at.y, visibility: pos ? undefined : "hidden" }} onKeyDown={onKey} onMouseDown={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()}>
        {items.map((it, i) => {
          if (!isRow(it)) return <div key={i} className="msep" role="separator" />;
          const more = !!it.submenu?.length;
          return (
            <button
              key={i}
              role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={it.checked}
              aria-haspopup={more ? "menu" : undefined}
              aria-expanded={more ? sub?.i === i : undefined}
              data-id={it.id}
              className={`mi ${sub?.i === i ? "open" : ""}`}
              disabled={it.enabled === false}
              onMouseEnter={(e) => {
                e.currentTarget.focus({ preventScroll: true });
                if (more) openSub(e.currentTarget, i, false);
                else setSub(null);
              }}
              onClick={(e) => (more ? openSub(e.currentTarget, i, e.detail === 0) : pick(it.id))}
            >
              {it.checked !== undefined && <span className="ck">{it.checked && <Icon name="check" className="sm" />}</span>}
              {icons && (it.icon ? <img className="pm-img" src={it.icon} alt="" draggable={false} /> : <Icon name={known[it.id]} className="sm" />)}
              <span className="pm-l">{it.label}</span>
              {it.accel && <span className="val">{it.accel}</span>}
              {more && <Icon name="chevR" className="sm pm-more" />}
            </button>
          );
        })}
      </div>
      {child && isRow(child) && child.submenu && (
        <List
          key={sub.i}
          items={child.submenu}
          at={{ x: sub.x, y: sub.y }}
          beside={sub.left}
          pick={pick}
          back={
            sub.keys
              ? () => {
                  const at = sub.i;
                  setSub(null);
                  box.current?.querySelectorAll<HTMLButtonElement>(":scope > .mi, :scope > .msep")[at]?.focus();
                }
              : undefined
          }
        />
      )}
    </>
  );
}
