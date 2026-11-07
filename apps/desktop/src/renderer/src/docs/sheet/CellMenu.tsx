import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../../icons";

// The grid's right-click menu, as Excel's: groups split by lines, an item with a submenu opens
// it to the side on hover. Drawn by the page, in the app's menu look (.vmenu).

export type MenuItem =
  | { kind: "sep" }
  | { kind: "item"; label: string; kbd?: string; icon?: IconName; checked?: boolean; disabled?: boolean; danger?: boolean; run?: () => void; items?: MenuItem[] };

export const sep: MenuItem = { kind: "sep" };
export const item = (label: string, run: (() => void) | undefined, extra: Partial<Extract<MenuItem, { kind: "item" }>> = {}): MenuItem => ({ kind: "item", label, run, ...extra });

export function CellMenu({ at, items, onClose }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  // Kept inside the window, as a native menu is.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(at.x, innerWidth - r.width - 4)), y: Math.max(4, Math.min(at.y, innerHeight - r.height - 4)) });
  }, [at.x, at.y]);
  useEffect(() => {
    const down = (e: MouseEvent) => !(e.target as HTMLElement).closest(".sht-menu") && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return <List items={items} at={pos} onClose={onClose} refEl={box} />;
}

function List({ items, at, onClose, refEl }: { items: MenuItem[]; at: { x: number; y: number }; onClose: () => void; refEl?: React.RefObject<HTMLDivElement | null> }) {
  const [open, setOpen] = useState<{ i: number; x: number; y: number } | null>(null);
  return (
    <div ref={refEl} className="vmenu sht-menu" role="menu" style={{ left: at.x, top: at.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((m, i) => {
        if (m.kind === "sep") return <div key={i} className="msep" />;
        const sub = !!m.items?.length;
        return (
          <button
            key={i}
            role="menuitem"
            className={`mi ${m.danger ? "danger" : ""} ${open?.i === i ? "open" : ""}`}
            disabled={m.disabled}
            aria-haspopup={sub || undefined}
            onMouseEnter={(e) => {
              if (!sub) return setOpen(null);
              const r = e.currentTarget.getBoundingClientRect();
              setOpen({ i, x: r.right + 220 > innerWidth ? r.left - 220 : r.right + 2, y: r.top - 4 });
            }}
            onClick={() => {
              if (sub || m.disabled) return;
              onClose();
              m.run?.();
            }}
          >
            {m.icon ? <Icon name={m.icon} /> : m.checked ? <Icon name="check" /> : null}
            <span>{m.label}</span>
            {m.kbd && <span className="val">{m.kbd}</span>}
            {sub && <Icon name="chevR" className="sht-menu-more" />}
          </button>
        );
      })}
      {open && (items[open.i] as Extract<MenuItem, { kind: "item" }>).items && <List items={(items[open.i] as Extract<MenuItem, { kind: "item" }>).items!} at={{ x: open.x, y: open.y }} onClose={onClose} />}
    </div>
  );
}
