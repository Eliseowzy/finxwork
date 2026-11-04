import { memo, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { botLine, botWorking } from "@finx/client";
import type { BotSummary } from "@finx/protocol";
import { RenameField } from "../components";
import { shortTime } from "../format";
import { Icon } from "../icons";
import { useNow, useStore, type Store } from "../store";
import { botContextMenu, thingsText } from "./actions";
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
  const busy = botWorking(b);
  return (
    <div
      className={`brow ${sel ? "sel" : ""}`}
      role="listitem"
      aria-current={sel || undefined}
      tabIndex={0}
      onClick={() => !renaming && store.current.selectBot(b.id)}
      onKeyDown={(e) => !renaming && e.key === "Enter" && store.current.selectBot(b.id)}
      onDoubleClick={(e) => !renaming && store.current.set({ renaming: b.id })}
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
            </>
          )}
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
