// Ribbon building blocks: command buttons, popovers, colour pickers. Every action goes through
// `RibbonController.run(id, args)`; the controller's status decides enabled/active/tooltips.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { RibbonController } from "../commands/controller";
import type { CommandStatus } from "../commands/types";
import { mix } from "../commands/quickStyles";
import type { ThemeColors } from "../commands/theme";
import { command } from "../commands/registry";
import { RIcon } from "./icons";

export const ControllerContext = createContext<RibbonController | null>(null);
export const useController = () => useContext(ControllerContext)!;

const mac = typeof navigator === "undefined" || /Mac|iPhone|iPad/.test(navigator.platform);
/** "Mod+Shift+C" → "⇧⌘C" on macOS, "Ctrl+Shift+C" elsewhere. */
export function chord(shortcut: string | undefined): string {
  if (!shortcut) return "";
  const parts = shortcut.split("+"), key = parts.pop()!;
  if (!mac) return [...parts.map((p) => p === "Mod" ? "Ctrl" : p), key.length === 1 ? key.toUpperCase() : key].join("+");
  const order = ["Ctrl", "Alt", "Shift", "Mod"], glyph: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘" };
  return parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((p) => glyph[p]).join("") + (key === "Space" ? "Space" : key.length === 1 ? key.toUpperCase() : key);
}

export function useRibbonT() {
  const { t } = useTranslation("session");
  const translate = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (key: string, options?: Record<string, unknown>) => translate(`pptx.ribbon.${key}`, options);
}

/** Label, reason and shortcut of a command, as its tooltip shows them. */
export function useCommandText() {
  const t = useRibbonT();
  return (id: string, status: CommandStatus) => {
    const label = t(`cmd.${id.replace(".", "_")}`);
    const reason = status.enabled ? "" : status.gate === "engine" ? t("reason.engine") : status.gate === "builtin" ? status.message ?? "" : status.gate && status.gate !== "not-ready" ? t(`reason.${status.gate}`) : "";
    const shortcut = chord(command(id)?.shortcut);
    return { label, title: `${label}${reason ? ` — ${reason}` : ""}${shortcut ? ` ${shortcut}` : ""}`, reason };
  };
}

export function CommandButton({ cmd, icon, args, big, showLabel, className = "", onClick }: {
  cmd: string; icon: string; args?: unknown; big?: boolean; showLabel?: boolean; className?: string; onClick?: (e: React.MouseEvent) => void;
}) {
  const controller = useController();
  const status = controller.status(cmd, args);
  const { label, title } = useCommandText()(cmd, status);
  return <button type="button" className={`pr-btn${big ? " big" : ""}${status.active === true ? " on" : ""}${status.gate === "engine" ? " todo" : ""} ${className}`}
    title={title} aria-label={label} aria-disabled={!status.enabled || undefined} aria-pressed={typeof status.active === "boolean" ? status.active : undefined}
    data-cmd={cmd} data-gate={status.gate ?? undefined}
    onMouseDown={(e) => e.preventDefault()}
    onClick={(e) => { if (!status.enabled) return; if (onClick) onClick(e); else void controller.run(cmd, args); }}>
    <RIcon name={icon} />{(big || showLabel) && <span className="pr-lbl">{label}</span>}
  </button>;
}

/** A popover anchored under its trigger, rendered fixed so the slide area never clips it. */
export function Drop({ trigger, title, children, disabled, className = "", width, testId, label }: {
  trigger: ReactNode; title: string; children: (close: () => void) => ReactNode; disabled?: boolean; className?: string; width?: number; testId?: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const w = panel.current?.offsetWidth ?? width ?? 220;
    setAt({ left: Math.max(6, Math.min(r.left, innerWidth - w - 6)), top: r.bottom + 4 });
  }, [open, width]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key, true); };
  }, [open]);
  return <>
    <button ref={button} type="button" className={`pr-btn pr-drop ${className}${open ? " open" : ""}`} title={title} aria-label={label ?? title} aria-haspopup="true" aria-expanded={open}
      aria-disabled={disabled || undefined} data-testid={testId} onMouseDown={(e) => e.preventDefault()} onClick={() => !disabled && setOpen((v) => !v)}>
      {trigger}<RIcon name="ChevronDown" className="pr-caret" />
    </button>
    {open && createPortal(<div ref={panel} className="pr-pop" role="menu" style={{ left: at.left, top: at.top, width }} onMouseDown={(e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); }}>
      {children(() => setOpen(false))}
    </div>, document.body)}
  </>;
}

export function MenuRow({ cmd, icon, args, close, label: override, swatch }: { cmd: string; icon?: string; args?: unknown; close: () => void; label?: string; swatch?: string }) {
  const controller = useController();
  const status = controller.status(cmd, args);
  const { label, title, reason } = useCommandText()(cmd, status);
  return <button type="button" role="menuitem" className={`pr-mi${status.active === true ? " on" : ""}`} aria-disabled={!status.enabled || undefined} title={reason ? title : undefined}
    data-cmd={cmd} onClick={() => { if (!status.enabled) return; close(); void controller.run(cmd, args); }}>
    {swatch ? <span className="pr-sw" style={{ background: swatch }} /> : icon ? <RIcon name={icon} /> : <span className="pr-sp" />}
    <span className="pr-mi-l">{override ?? label}</span>
    {status.gate === "engine" ? <span className="pr-todo">{useRibbonT()("todo")}</span> : command(cmd)?.shortcut ? <kbd>{chord(command(cmd)?.shortcut)}</kbd> : null}
  </button>;
}

const STANDARD = ["#C00000", "#FF0000", "#FFC000", "#FFFF00", "#92D050", "#00B050", "#00B0F0", "#0070C0", "#002060", "#7030A0"];

/** Theme colours with four tints/shades each, PowerPoint's standard row, and a custom picker. */
export function ColorGrid({ theme, onPick, none }: { theme: ThemeColors; onPick: (color: string | null) => void; none?: string }) {
  const t = useRibbonT();
  const base = [theme.lt1, theme.dk1, theme.lt2, theme.dk2, theme.accent1, theme.accent2, theme.accent3, theme.accent4, theme.accent5, theme.accent6];
  const rows = [base, ...[0.8, 0.6, 0.4, -0.25, -0.5].map((amount) => base.map((c) => mix(c, amount)))];
  return <div className="pr-colors">
    {none && <button type="button" className="pr-mi" onClick={() => onPick(null)}><span className="pr-sw none" /><span className="pr-mi-l">{none}</span></button>}
    <div className="pr-cap">{t("themeColors")}</div>
    {rows.map((row, i) => <div key={i} className={`pr-crow${i === 0 ? " first" : ""}`}>{row.map((c, j) => <button key={j} type="button" className="pr-chip" style={{ background: c }} title={c} aria-label={c} onClick={() => onPick(c)} />)}</div>)}
    <div className="pr-cap">{t("standardColors")}</div>
    <div className="pr-crow first">{STANDARD.map((c) => <button key={c} type="button" className="pr-chip" style={{ background: c }} title={c} aria-label={c} onClick={() => onPick(c)} />)}</div>
    <label className="pr-mi pr-custom"><RIcon name="Palette" /><span className="pr-mi-l">{t("moreColors")}</span>
      <input type="color" onChange={(e) => onPick(e.target.value.toUpperCase())} /></label>
  </div>;
}
