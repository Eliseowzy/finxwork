import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "../icons";
import { useStore } from "../store";

type FootItem = { id: "settings" | "models" | "about"; icon: IconName; shortcut?: string } | null;

/**
 * The sidebar's foot: who uses this computer (and a dot when finx doesn't answer).
 * It opens upward, as wide as the foot, with the settings and what finxwork is.
 */
export function FootMenu() {
  const st = useStore();
  const { t } = useTranslation("common");
  // "key": opened from the keyboard, so the first item is chosen at once, as in a native menu.
  const [open, setOpen] = useState<false | "mouse" | "key">(false);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLButtonElement>(null);
  const items: FootItem[] = [
    { id: "settings", icon: "gear", shortcut: "⌘," },
    { id: "models", icon: "cube" },
    null,
    { id: "about", icon: "info" },
  ];
  useEffect(() => {
    if (!open) return;
    (open === "key" ? menu.current?.querySelector<HTMLElement>("[role=menuitem]") : menu.current)?.focus();
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const blur = () => setOpen(false);
    document.addEventListener("mousedown", close);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("blur", blur);
    };
  }, [open]);
  const choose = (id: NonNullable<FootItem>["id"]) => {
    setOpen(false);
    if (id === "about") window.finx?.showAbout();
    else window.finx?.openSettings(id === "models" ? "models" : undefined);
  };
  // The keyboard, as in a native menu: arrows move, Esc closes back to the foot.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const all = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    const go = { ArrowDown: (i + 1) % all.length, ArrowUp: i <= 0 ? all.length - 1 : i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (go !== undefined) {
      e.preventDefault();
      all[go]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      foot.current?.focus();
    }
  };
  const name = window.finx?.userName || "FinxWork";
  // A dot only when it is worth noticing: finx doesn't answer, or this is the demo.
  const status = st.status;
  const line =
    st.kernel === "down" ? t("kernel.down")
    : status?.state === "starting" ? t("kernel.starting")
    : status?.state === "reconnecting" || st.kernel === "reconnecting" ? t("kernel.reconnecting")
    : st.kernel === "connecting" ? t("kernel.connecting")
    : window.finx?.kernel === "finx" ? t(status?.replacing ? "kernel.readyUpdate" : "kernel.ready", { server: st.server })
    : t("kernel.mock");
  return (
    <div className="acct" ref={ref}>
      {open && (
        <div className="acct-menu" role="menu" aria-label={t("foot.label")} tabIndex={-1} ref={menu} onKeyDown={onKeyDown} onMouseLeave={() => menu.current?.focus()}>
          {items.map((it, i) =>
            it ? (
              <button key={it.id} className="mi" role="menuitem" tabIndex={-1} onMouseEnter={(e) => e.currentTarget.focus()} onClick={() => choose(it.id)}>
                <Icon name={it.icon} />
                <span>{t(`foot.${it.id}`)}</span>
                {it.shortcut && <span className="kbd">{it.shortcut}</span>}
              </button>
            ) : (
              <div key={i} className="msep" role="separator" />
            ),
          )}
        </div>
      )}
      <button className="side-foot" ref={foot} aria-label={t("foot.label")} aria-haspopup="menu" aria-expanded={!!open} onClick={(e) => setOpen(open ? false : e.detail ? "mouse" : "key")}>
        <span className="av" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <span className="who">
          <b>{name}</b>
        </span>
        {/* One line, the name: finx's state only when something is off, as a dot that says what on hover. */}
        {(st.kernel !== "ready" || window.finx?.kernel !== "finx") && <i className={`dotc ${st.kernel === "down" ? "" : "warn"}`} title={line} aria-label={line} />}
        <Icon name="chevD" className="sm chev" />
      </button>
    </div>
  );
}
