import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { botLine, botWorking } from "@finx/client";
import type { BotSummary } from "@finx/protocol";
import { RenameField } from "../components";
import { shortTime } from "../format";
import { Icon } from "../icons";
import { menuKeys } from "../sidebar/Sidebar";
import { useNow, useStore, type Store } from "../store";
import { botContextMenu, rowActions, runBotAction, thingsText, type BotAction } from "./actions";
import { BotAvatar } from "./Avatar";

/**
 * Bot mode's list (bot-mode-design §6.2), like a chat app's: each bot's
 * avatar, name, time, last message (or what it does, or what it waits for)
 * and unread count. Pinned bots first, then the latest message first.
 */
export function BotList() {
  const st = useStore();
  const { t } = useTranslation("bots");
  // The rows get the store as of a click, so a change elsewhere doesn't render them again.
  const latest = useRef(st);
  latest.current = st;
  const selected = st.selection.kind === "bot" ? st.selection.id : null;
  return (
    <div className="side-list bots fadein" role="list" aria-label={t("list.label")}>
      {st.bots.map((b) => (
        <BotRow key={b.id} b={b} sel={b.id === selected} renaming={st.renaming === b.id} store={latest} />
      ))}
      {!st.botsLoaded && (
        <div className="loadrow">
          <span className="mini-spin" />
          {t("list.loading")}
        </div>
      )}
    </div>
  );
}

const BotRow = memo(function BotRow({ b, sel, renaming, store }: { b: BotSummary; sel: boolean; renaming: boolean; store: RefObject<Store> }) {
  const { t } = useTranslation("bots");
  const now = useNow(30_000);
  const [menu, setMenu] = useState<{ x: number; y: number; key: boolean } | null>(null);
  const busy = botWorking(b);
  return (
    <div
      className={`brow ${sel ? "sel" : ""} ${menu ? "menu-open" : ""}`}
      role="listitem"
      aria-current={sel || undefined}
      tabIndex={0}
      onClick={() => !renaming && store.current.selectBot(b.id)}
      onKeyDown={(e) => !renaming && e.key === "Enter" && store.current.selectBot(b.id)}
      onDoubleClick={(e) => !renaming && !(e.target as Element).closest(".rowact, .vmenu") && store.current.set({ renaming: b.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        void botContextMenu(store.current, b);
      }}
    >
      <BotAvatar bot={b} size={36} busy={busy} />
      <div className="bmain">
        <div className="bl1">
          {renaming ? (
            <RenameField
              initial={b.name}
              className="srename"
              maxLength={20}
              end={(name) => {
                const st = store.current;
                st.set({ renaming: null });
                const v = name?.trim();
                if (v && v !== b.name) st.run(() => st.call("bots/update", { bot_id: b.id, name: v }));
              }}
            />
          ) : (
            <>
              <span className="bname" title={b.name}>{b.name}</span>
              {b.pinned && <Icon name="pin" className="bpin" />}
              <span className="btime">{b.last ? shortTime(new Date(b.last.ts), now) : ""}</span>
              <button
                className="rowact"
                title={t("menu.more")}
                aria-label={t("menu.more")}
                aria-haspopup="menu"
                aria-expanded={!!menu}
                onClick={(e) => {
                  e.stopPropagation();
                  // Shown on hover only: without a size (pressed from the keyboard), the row places the menu.
                  const own = e.currentTarget.getBoundingClientRect();
                  const r = own.width ? own : (e.currentTarget.closest(".bl1") ?? e.currentTarget).getBoundingClientRect();
                  setMenu(menu ? null : { x: r.right, y: r.bottom + 4, key: e.detail === 0 });
                }}
              >
                <Icon name="more" className="sm" />
              </button>
            </>
          )}
          {menu && <BotMenu b={b} items={rowActions(b)} at={menu} store={store} onClose={() => setMenu(null)} />}
        </div>
        <div className="bl2">
          <RowLine b={b} />
          {!sel && (b.unread ?? 0) > 0 && <span className="bbadge">{b.unread}</span>}
        </div>
      </div>
    </div>
  );
});

/** The row's second line (§6.2): an approval waiting, else what it does, else its last message. */
function RowLine({ b }: { b: BotSummary }) {
  const { t } = useTranslation("bots");
  const line = botLine(b);
  switch (line.kind) {
    case "waiting":
      return (
        <span className="bprev">
          <span className="btag">{t("line.waiting")}</span> {line.text}
        </span>
      );
    case "helpers":
      return <span className="bprev"><span className="shimmer">{t("line.helpers", { things: thingsText(line.count) })}</span></span>;
    case "typing":
      return <span className="bprev"><span className="shimmer">{t("line.typing")}</span></span>;
    case "empty":
      return <span className="bprev">{t("line.empty")}</span>;
    case "last": {
      const text = line.text || (line.images > 0 ? t("line.image") : line.files.length ? t("line.file", { name: line.files[0] }) : "");
      return <span className="bprev">{text}</span>;
    }
  }
}

/**
 * A bot's ⋯ menu (§6.16), under its button; clicks stay in the menu. On the document's body: in a
 * bar of liquid glass, its backdrop filter would make `position: fixed` relative to the bar.
 */
export function BotMenu({ b, items, at, store, onClose }: { b: BotSummary; items: BotAction[]; at: { x: number; y: number; key: boolean }; store: RefObject<Store>; onClose: () => void }) {
  const { t } = useTranslation("bots");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: at.y });
  useLayoutEffect(() => {
    const el = ref.current!;
    const top = at.y + el.offsetHeight > innerHeight - 8 ? at.y - el.offsetHeight - 30 : at.y;
    setPos({ left: Math.max(8, at.x - el.offsetWidth), top });
    (at.key ? el.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)") : el)?.focus();
  }, [at]);
  useEffect(() => {
    const outside = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.("[aria-expanded=true]") && onClose();
    document.addEventListener("mousedown", outside);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      className="vmenu"
      role="menu"
      aria-label={t("menu.more")}
      tabIndex={-1}
      ref={ref}
      style={pos}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => menuKeys(e, ref.current, onClose)}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {items.map((a, i) =>
        a ? (
          <button
            key={a.id}
            className={`mi ${a.danger ? "danger" : ""}`}
            role="menuitem"
            tabIndex={-1}
            disabled={a.enabled === false}
            onMouseMove={(e) => e.currentTarget.focus()}
            onClick={() => (onClose(), runBotAction(store.current, b, a.id))}
          >
            <span>{a.label}</span>
            {a.note && <span className="mi-note">{a.note}</span>}
          </button>
        ) : (
          <div key={`sep${i}`} className="msep" role="separator" />
        ),
      )}
    </div>,
    document.body,
  );
}
