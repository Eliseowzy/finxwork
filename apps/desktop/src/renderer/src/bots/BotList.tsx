import { memo, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { botLine, botTime, botWorking, groupLine, groupTime } from "@finx/client";
import type { BotSummary, GroupSummary } from "@finx/protocol";
import { RenameField } from "../components";
import { shortTime } from "../format";
import { Icon } from "../icons";
import { useLists, useNow, useStore, type Store } from "../store";
import { botContextMenu } from "./actions";
import { BotAvatar } from "./Avatar";
import { GroupAvatar } from "../groups/GroupAvatar";
import { groupContextMenu } from "../groups/actions";
import { measurePitch, spacer, useRowWindow, type RowPitch } from "../sidebar/rowWindow";

/**
 * Bot mode's list (bot-mode-design §6.2, bot-group-chat-dev-brief §5), like a chat app's: each
 * bot's and each group's avatar, name, time, last message (or what it does, or what it waits for)
 * and unread count. Pinned rows first, then the latest message first.
 */
export function BotList() {
  const st = useStore();
  const { t: tg } = useTranslation("groups");
  // The rows get the store as of a click, so a change elsewhere doesn't render them again.
  const latest = useRef(st);
  latest.current = st;
  const bots = useLists((l) => l.bots);
  const groups = useLists((l) => l.groups);
  const loaded = useLists((l) => l.botsLoaded && l.groupsLoaded);
  const selected = st.selection.kind === "bot" ? st.selection.id : st.selection.kind === "group" ? st.selection.id : null;
  // One list, as a chat app's: a group and a bot sit by the same clock (bot-group-chat-dev-brief §5).
  const rows = useMemo<Row[]>(() => {
    const all: Row[] = [
      ...bots.map((b): Row => ({ kind: "bot", id: b.id, time: botTime(b), pinned: !!b.pinned, bot: b })),
      ...groups.map((g): Row => ({ kind: "group", id: g.id, time: groupTime(g), pinned: !!g.pinned, group: g })),
    ];
    return all.sort((a, b) => +b.pinned - +a.pinned || b.time - a.time || a.id.localeCompare(b.id));
  }, [bots, groups]);
  // Only the rows in sight are drawn (rowWindow.ts); the list starts with its first row.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [pitch, setPitch] = useState<RowPitch>({ pitch: 50, gap: 2 });
  useLayoutEffect(() => setPitch((p) => measurePitch(scroller, ".brow", p)));
  const [first, end] = useRowWindow(scroller, () => 0, rows.length, pitch);
  return (
    <div ref={setScroller} className="side-list bots fadein" role="list" aria-label={tg("list.label")}>
      {first > 0 && <div aria-hidden="true" style={{ height: spacer(first, pitch), flex: "none" }} />}
      {rows.slice(first, end).map((r) =>
        r.kind === "bot" ? (
          <BotRow key={r.id} b={r.bot} sel={r.id === selected} renaming={st.renaming === r.id} store={latest} />
        ) : (
          <GroupRow key={r.id} g={r.group} sel={r.id === selected} renaming={st.renaming === r.id} store={latest} />
        ),
      )}
      {end < rows.length && <div aria-hidden="true" style={{ height: spacer(rows.length - end, pitch), flex: "none" }} />}
      {!loaded && (
        <div className="loadrow">
          <span className="mini-spin" />
          {tg("list.loading")}
        </div>
      )}
    </div>
  );
}

/** A row of the list: a bot or a group, with what it sorts by. */
type Row =
  | { kind: "bot"; id: string; time: number; pinned: boolean; bot: BotSummary }
  | { kind: "group"; id: string; time: number; pinned: boolean; group: GroupSummary };

/** A group's row: its members' faces, its name, when it was last busy, and its last line. */
const GroupRow = memo(function GroupRow({ g, sel, renaming, store }: { g: GroupSummary; sel: boolean; renaming: boolean; store: RefObject<Store> }) {
  const { t } = useTranslation("groups");
  const now = useNow(30_000);
  return (
    <div
      className={`brow grow ${sel ? "sel" : ""}`}
      role="listitem"
      aria-current={sel || undefined}
      tabIndex={0}
      onClick={() => !renaming && store.current.selectGroup(g.id)}
      onKeyDown={(e) => !renaming && e.key === "Enter" && store.current.selectGroup(g.id)}
      onDoubleClick={() => !renaming && store.current.set({ renaming: g.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        void groupContextMenu(store.current, g);
      }}
    >
      <span className="bavatar">
        <GroupAvatar members={g.members} />
        {g.external && (
          <span className="bext" title={t("head.external")} aria-label={t("head.external")}>
            <Icon name="globe" />
          </span>
        )}
      </span>
      <div className="bmain">
        <div className="bl1">
          {renaming ? (
            <RenameField
              initial={g.name}
              className="srename"
              maxLength={40}
              end={(name) => {
                const st = store.current;
                st.set({ renaming: null });
                const v = name?.trim();
                if (v && v !== g.name) st.run(() => st.call("groups/update", { id: g.id, name: v }));
              }}
            />
          ) : (
            <>
              <span className="bname" title={g.name}>{g.name}</span>
              {g.pinned && <Icon name="pin" className="bpin" />}
              <span className="btime">{g.last ? shortTime(new Date(g.last.ts), now) : ""}</span>
            </>
          )}
        </div>
        <div className="bl2">
          <GroupRowLine g={g} />
          {!sel && (g.unread ?? 0) > 0 && <span className="bbadge">{g.unread}</span>}
        </div>
      </div>
    </div>
  );
});

/** The group row's second line: who is answering, else its last message, with who said it. */
function GroupRowLine({ g }: { g: GroupSummary }) {
  const { t } = useTranslation("groups");
  const line = groupLine(g);
  switch (line.kind) {
    case "typing":
      return <span className="bprev">{line.names.join("、")} · {t("row.typing")}</span>;
    case "empty":
      return <span className="bprev">{t("row.empty")}</span>;
    case "last": {
      const who = line.from.kind === "owner" ? t("page.you") : line.from.kind === "bot" ? line.from.name : null;
      const text = line.text || (line.images > 0 ? t("page.files") : line.files.length ? line.files[0] : "");
      return <span className="bprev">{who ? `${who}: ${text}` : text}</span>;
    }
  }
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
      <span className="bavatar">
        <BotAvatar bot={b} size={36} busy={busy} />
        {b.source && (
          <span className="bext" title={t("external.mark")} aria-label={t("external.mark")}>
            <Icon name="globe" />
          </span>
        )}
      </span>
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
    case "agents":
    case "typing":
      return <span className="bprev">{t("line.typing")}</span>;
    case "empty":
      return <span className="bprev">{t("line.empty")}</span>;
    case "last": {
      const text = line.text || (line.images > 0 ? t("line.image") : line.files.length ? t("line.file", { name: line.files[0] }) : "");
      return <span className="bprev">{text}</span>;
    }
  }
}
