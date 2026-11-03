import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { agoText } from "../format";
import { Icon } from "../icons";
import { menuKeys } from "../sidebar/Sidebar";
import { useNow } from "../store";
import type { CatalogConnector } from "../../../shared/catalog";
import { classify, type LogoLook } from "../../../shared/logo";
import { monogram, type StatusLook } from "./model";

// The page's small parts, as the prototype draws them (docs/desktop/customize-demo.html).

/** A path with the home folder as ~. */
export function tilde(path: string): string {
  const home = window.finx?.home;
  return home && (path === home || path.startsWith(home + "/")) ? "~" + path.slice(home.length) : path;
}

export function SkillTile({ size }: { size?: "xl" }) {
  return (
    <div className={`cz-tile ${size ?? ""}`}>
      <Icon name="skill" />
    </div>
  );
}

const SAMPLE = 64;
const MIN_LOGO = 16;
const looks = new Map<string, Promise<Seen | null>>();
type Seen = LogoLook & { natural: number | null };

/** Decodes a logo once and reads its shape; null when it can't be drawn. */
function see(src: string): Promise<Seen | null> {
  let seen = looks.get(src);
  if (!seen) {
    seen = new Promise((done) => {
      const img = new Image();
      img.onerror = () => done(null);
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = SAMPLE;
          const g = canvas.getContext("2d", { willReadFrequently: true })!;
          g.drawImage(img, 0, 0, SAMPLE, SAMPLE);
          const look = classify(g.getImageData(0, 0, SAMPLE, SAMPLE).data, SAMPLE);
          const vector = src.startsWith("data:image/svg");
          done(look && { ...look, natural: vector ? null : Math.min(img.naturalWidth, img.naturalHeight) });
        } catch {
          done(null);
        }
      };
      img.src = src;
    });
    looks.set(src, seen);
  }
  return seen;
}

/** A logo's shape: undefined while it is read, null when there is none to draw. */
function useLogo(src?: string | null): Seen | null | undefined {
  const [seen, setSeen] = useState<{ src: string; look: Seen | null } | null>(null);
  useEffect(() => {
    if (!src) return;
    let live = true;
    see(src).then((look) => live && setSeen({ src, look }));
    return () => void (live = false);
  }, [src]);
  if (!src) return null;
  return seen?.src === src ? seen.look : undefined;
}

const catalogLogos = import.meta.glob<string>("../assets/connectors/*.{svg,png}", { eager: true, query: "?url", import: "default" });

/** A catalog entry's logo, which ships with the app: until the server's own is found, and before it is added. */
export function catalogLogo(cat?: CatalogConnector | null): string | undefined {
  return cat?.logo ? catalogLogos[`../assets/connectors/${cat.logo}`] : undefined;
}

/**
 * A connector's tile: its logo when one was found (mcp-design §13.9), else its initials. A
 * logo that is a tile fills the shape edge to edge under a hairline, as a store shows an app
 * icon; one too small to fill it without blurring, or a mark on transparency, sits on a plate
 * at no more than its own size (customize-design §10.10).
 */
export function ServerTile({ name, mono, icon, size }: { name: string; mono?: string; icon?: string | null; size?: "xl" }) {
  const look = useLogo(icon);
  const side = size === "xl" ? 52 : 32;
  if (look === undefined) return <div className={`cz-tile ${size ?? ""}`} />;
  // Smaller than a tab's favicon, a logo can't be made out: the initials say more.
  if (!icon || !look || (look.natural !== null && look.natural < MIN_LOGO)) return <div className={`cz-tile ${size ?? ""}`}>{mono || monogram(name)}</div>;
  const crop = look.tile;
  if (crop && (look.natural === null || look.natural * crop.w >= side))
    return (
      <div className={`cz-tile logo ${look.cut ? "cut" : ""} ${size ?? ""}`}>
        <img
          src={icon}
          alt=""
          draggable={false}
          style={{ width: `${100 / crop.w}%`, height: `${100 / crop.h}%`, left: `${(-crop.x / crop.w) * 100}%`, top: `${(-crop.y / crop.h) * 100}%` }}
        />
      </div>
    );
  const room = Math.round(side * 0.625);
  const px = look.natural === null ? room : Math.min(room, look.natural);
  return (
    <div className={`cz-tile glyph ${look.tone} ${size ?? ""}`}>
      <img src={icon} alt="" draggable={false} style={{ width: px, height: px }} />
    </div>
  );
}

/** A group of 我的 or 发现: its heading with the count, then the rows or cards. */
export function Section({ title, count, hint, note, children }: { title: string; count?: number; hint?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="cz-sect">
      <div className="fhead">
        {title}
        {count !== undefined && <span className="n">{count}</span>}
        {hint && <span className="hint">· {hint}</span>}
      </div>
      {note}
      {children}
    </section>
  );
}

export function Switch({ on, label, onChange, disabled = false }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      className={`sw ${on ? "on" : ""}`}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    />
  );
}

/** "3 小时前检测", or how many open sessions use it. */
export function useStatusSource(look: StatusLook): string | undefined {
  const { t } = useTranslation("customize");
  const now = useNow(60_000);
  if (look.kind !== "ok") return undefined;
  if (look.sessions) return t("connector.fromSessions", { count: look.sessions });
  return look.checkedAt ? t("connector.checkedAt", { ago: agoText(new Date(look.checkedAt), now) }) : t("connector.neverChecked");
}

/** A server's state in one line (§8.1), with the action it calls for. */
export function Status({ look, onCheck, onLogin, withAction = true }: { look: StatusLook; onCheck: () => void; onLogin?: () => void; withAction?: boolean }) {
  const { t } = useTranslation("customize");
  const source = useStatusSource(look);
  const action = (label: string, run: () => void = onCheck) =>
    withAction && (
      <>
        {" · "}
        <button
          className="link"
          onClick={(e) => {
            e.stopPropagation();
            run();
          }}
        >
          {label}
        </button>
      </>
    );
  switch (look.kind) {
    case "off":
      return <span className="cz-st">{look.forYou ? t("connector.offForYou") : t("connector.off")}</span>;
    case "untrusted":
      return (
        <span className="cz-st warn">
          <i className="dotc warn" />
          {t("connector.untrusted")}
        </span>
      );
    case "checking":
      return (
        <span className="cz-st">
          <span className="mini-spin cz-spin" />
          {t("connector.checking")}
        </span>
      );
    case "ok":
      return (
        <span className="cz-st ok" title={source}>
          <i className="dotc on" />
          {t("connector.ok", { count: look.tools })}
        </span>
      );
    case "failed":
      return (
        <span className="cz-st bad" title={look.error ?? undefined}>
          <i className="dotc bad" />
          {t("connector.failed")}
          {action(t("connector.retry"))}
        </span>
      );
    case "needs_login":
      return (
        <span className="cz-st warn">
          <i className="dotc warn" />
          {t("connector.needsLogin")}
          {onLogin && action(t("connector.signInShort"), onLogin)}
        </span>
      );
    default:
      return (
        <span className="cz-st">
          <i className="dotc" />
          {t("connector.unknown")}
          {action(t("connector.check"))}
        </span>
      );
  }
}

/** An item; `checked` makes it one of a choice, drawn with a check column; `extra` follows its label. */
export type MenuItem = { id: string; label: string; icon?: string; desc?: string; danger?: boolean; checked?: boolean; disabled?: boolean; extra?: ReactNode; run: () => void } | { header: string } | null;

/**
 * A menu under its button, right-aligned, as the sidebar's rows have: the keyboard works as in
 * a native menu, and a click outside or leaving the window closes it.
 */
export function PopMenu({ anchor, items, label, onClose }: { anchor: DOMRect; items: MenuItem[]; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: anchor.bottom + 6 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const below = anchor.bottom + 6;
    const top = below + el.offsetHeight > innerHeight - 8 ? Math.max(8, anchor.top - el.offsetHeight - 6) : below;
    setPos({ left: Math.max(8, anchor.right - el.offsetWidth), top });
    el.focus();
  }, [anchor]);
  useEffect(() => {
    const outside = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.("[aria-expanded=true]") && onClose();
    // A scroll under it leaves it pointing at nothing, so it closes, as a native menu would.
    const scrolled = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    document.addEventListener("mousedown", outside);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return (
    <div
      className="vmenu cz-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      ref={ref}
      style={pos}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => menuKeys(e, ref.current, onClose)}
    >
      {items.map((it, i) =>
        it === null ? (
          <div key={i} className="msep" role="separator" />
        ) : "header" in it ? (
          <div key={i} className="mh">
            {it.header}
          </div>
        ) : (
          <button
            key={it.id}
            className={`mi ${it.danger ? "danger" : ""} ${it.desc ? "tall" : ""}`}
            role={it.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={it.checked}
            tabIndex={-1}
            disabled={it.disabled}
            onMouseMove={(e) => e.currentTarget.focus()}
            onClick={() => (onClose(), it.run())}
          >
            {it.checked !== undefined && <span className="ck">{it.checked && <Icon name="check" className="sm" />}</span>}
            {it.icon && <Icon name={it.icon} />}
            {it.desc ? (
              <span className="two">
                <span className="l1">
                  {it.label}
                  {it.extra}
                </span>
                <span>{it.desc}</span>
              </span>
            ) : (
              <span>
                {it.label}
                {it.extra}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );
}

/** A ⋯ button that opens its menu. */
export function MoreButton({ label, items }: { label: string; items: () => MenuItem[] }) {
  const [at, setAt] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        className={`cz-more ${at ? "open" : ""}`}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={(e) => {
          e.stopPropagation();
          setAt(at ? null : e.currentTarget.getBoundingClientRect());
        }}
      >
        <Icon name="more" />
      </button>
      {at && <PopMenu anchor={at} items={items()} label={label} onClose={() => setAt(null)} />}
    </>
  );
}

export type Choice<T extends string> = { id: T; label: string; desc?: string; tag?: string; off?: string | false };

/**
 * A pop-up button, as a native form has: the chosen item and the up-down chevrons. Its menu
 * lists the choices with what each does; one that can't be had is greyed with the reason, and
 * the one a check found is marked, as is the one a catalog entry recommends.
 */
export function PopUp<T extends string>({ label, value, choices, found, recommended, onChange }: { label: string; value: T; choices: Choice<T>[]; found?: T | null; recommended?: T; onChange: (id: T) => void }) {
  const { t } = useTranslation("customize");
  const [at, setAt] = useState<DOMRect | null>(null);
  const mark = <span className="badge acc">{t("addc.detected")}</span>;
  const recommends = <span className="badge acc">{t("addc.recommended")}</span>;
  const chosen = choices.find((c) => c.id === value);
  return (
    <>
      <button
        className={`cz-pop ${at ? "open" : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={(e) => {
          e.stopPropagation();
          setAt(at ? null : e.currentTarget.getBoundingClientRect());
        }}
      >
        {value === found ? (
          <span className="badge acc">
            <Icon name="check" className="sm" />
            {t("addc.detected")}
          </span>
        ) : (
          value === recommended && recommends
        )}
        <span className="lbl">{chosen?.label}</span>
        <Icon name="updown" className="chev" />
      </button>
      {at && (
        <PopMenu
          anchor={at}
          label={label}
          onClose={() => setAt(null)}
          items={choices.map((c) => ({
            id: c.id,
            label: c.label,
            desc: c.off || c.desc,
            disabled: !!c.off,
            checked: c.id === value,
            extra: (
              <>
                {c.tag && <span className="badge">{c.tag}</span>}
                {c.id === found ? mark : c.id === recommended && recommends}
              </>
            ),
            run: () => onChange(c.id),
          }))}
        />
      )}
    </>
  );
}
