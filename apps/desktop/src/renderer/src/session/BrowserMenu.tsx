import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserMenuAction, BrowserMenuState, BrowserViewport } from "../../../shared/bridge";
import { Icon } from "../icons";
import { useOverlay } from "../overlays";

// The browser panel's ⋯ menu, drawn as the app's other menus. The tab's view lies above the
// page, so while the menu is open it counts as an overlay: the tab steps aside, a picture of it
// in its place. What each item does is the main process's (main/browser/menu.ts).

type Pane = "viewport" | "cookies";
const viewports: BrowserViewport[] = ["responsive", "mobile", "tablet"];

export function BrowserMenu({ targetId }: { targetId: string | null }) {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState<false | "mouse" | "key">(false);
  const [state, setState] = useState<BrowserMenuState | null>(null);
  const [pane, setPane] = useState<{ id: Pane; key: boolean } | null>(null);
  const [at, setAt] = useState({ x: 0, y: 0, sx: 0, sy: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  useOverlay(!!open && !!state);

  const close = (back: boolean) => {
    setOpen(false);
    setPane(null);
    setState(null);
    if (back) btn.current?.focus();
  };
  const run = (a: BrowserMenuAction) => {
    window.finx?.browserMenuAction(targetId, a);
    close(true);
  };

  useEffect(() => {
    if (!open || !state) return;
    (open === "key" ? menu.current?.querySelector<HTMLElement>("[role^=menuitem]:not(:disabled)") : menu.current)?.focus();
    const outside = (e: MouseEvent) => ![btn, menu, sub].some((r) => r.current?.contains(e.target as Node)) && close(false);
    const blur = () => close(false);
    document.addEventListener("mousedown", outside);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("blur", blur);
    };
  }, [open, state]);
  // The submenu beside its row, on the left when there's no room on the right.
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
    const finx = window.finx;
    if (!finx) return;
    const r = btn.current!.getBoundingClientRect();
    setAt({ x: innerWidth - r.right, y: r.bottom + 4, sx: 0, sy: 0 });
    setOpen(e.detail ? "mouse" : "key");
    void finx.browserMenuState(targetId).then(setState, () => close(false));
  };

  const move = (e: ReactKeyboardEvent, box: HTMLElement | null) => {
    const all = [...(box?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    const go = { ArrowDown: (i + 1) % all.length, ArrowUp: i <= 0 ? all.length - 1 : i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (go === undefined) return false;
    e.preventDefault();
    all[go]?.focus();
    return true;
  };
  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (move(e, menu.current)) return setPane(null);
    const id = (document.activeElement as HTMLElement | null)?.dataset.pane as Pane | undefined;
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

  /** A row that opens a submenu, with the choice in effect beside it. */
  const paneRow = (id: Pane, label: string, value: string, disabled = false) => (
    <button
      className={`mi ${pane?.id === id ? "open" : ""}`}
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={pane?.id === id}
      tabIndex={-1}
      data-pane={id}
      disabled={disabled}
      onMouseMove={(e) => document.activeElement !== e.currentTarget && (e.currentTarget.focus(), setPane({ id, key: false }))}
      onClick={() => setPane({ id, key: false })}
    >
      <span>{label}</span>
      <span className="val">{value}</span>
      <Icon name="chevR" className="sm" />
    </button>
  );
  /** A plain row; hovering it closes any submenu. */
  const item = (label: string, a: BrowserMenuAction | (() => void), disabled = false, danger = false) => (
    <button className={`mi ${danger ? "danger" : ""}`} role="menuitem" tabIndex={-1} disabled={disabled}
      onMouseMove={(e) => document.activeElement !== e.currentTarget && (e.currentTarget.focus(), setPane(null))} onClick={() => (typeof a === "function" ? (close(false), a()) : run(a))}>
      {label}
    </button>
  );
  const choices =
    pane?.id === "viewport"
      ? viewports.map((v) => ({ label: t(`browser.menu.viewports.${v}`), on: state?.viewport === v, a: { action: "viewport", viewport: v } as BrowserMenuAction }))
      : (["always", "untilQuit"] as const).map((c) => ({ label: t(`browser.menu.${c}`), on: state?.cookies === c, a: { action: "cookies", cookies: c } as BrowserMenuAction }));

  return (
    <>
      <button ref={btn} className={`tb brp-more no-drag ${open ? "on" : ""}`} aria-label={t("browser.more")} title={t("browser.more")} aria-haspopup="menu" aria-expanded={!!open} onClick={toggle}>
        <Icon name="more" />
      </button>
      {open && state && (
        <div className="vmenu no-drag" role="menu" aria-label={t("browser.more")} tabIndex={-1} ref={menu} style={{ right: at.x, top: at.y }} onKeyDown={onMenuKey}>
          {item(state.browser ? t("browser.menu.openIn", { browser: state.browser }) : t("browser.menu.openInDefault"), { action: "open" }, !state.web)}
          {item(t("browser.menu.copyUrl"), { action: "copy" }, !state.web)}
          {item(t("browser.menu.screenshot"), { action: "screenshot" }, !state.web)}
          <div className="msep" role="separator" />
          {paneRow("viewport", t("browser.menu.viewport"), t(`browser.menu.viewports.${state.viewport}`), !targetId)}
          <div className="msep" role="separator" />
          <div className="mh">{t("browser.menu.cookies")}</div>
          {paneRow("cookies", t("browser.menu.keepCookies"), t(`browser.menu.${state.cookies}`))}
          {item(t("browser.menu.clearData"), { action: "clear" }, false, true)}
        </div>
      )}
      {open && state && pane && (
        <div className="vmenu no-drag" role="menu" tabIndex={-1} ref={sub} style={{ left: at.sx, top: at.sy }} onKeyDown={onSubKey}>
          {choices.map((c) => (
            <button key={c.label} className="mi" role="menuitemradio" aria-checked={c.on} tabIndex={-1} onMouseMove={(e) => e.currentTarget.focus()} onClick={() => run(c.a)}>
              <span className="ck">{c.on && <Icon name="check" className="sm" />}</span>
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
