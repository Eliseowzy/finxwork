import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { hourMinute, insertMention, mentionChoices, memberName, plain, threadMessages, typingMention } from "@finx/client";
import type { GroupApprovalParams, GroupFile, GroupMessage, GroupQuote, GroupSummary, GroupThread } from "@finx/protocol";
import { GroupFilePreview } from "./GroupFilePreview";
import { SidebarToggle } from "../components";
import { Composer } from "../composer/Composer";
import { Markdown } from "../session/Markdown";
import { GlassBar } from "../glass";
import { Icon } from "../icons";
import { shortTime, timeLine } from "../format";
import { errorText, useLists, useNow, useStore } from "../store";
import { Avatar } from "../bots/Avatar";
import { GroupAvatar } from "./GroupAvatar";
import { GroupPanel } from "./GroupPanel";
import { usePanelWidth } from "../panelWidth";
import { useMentionHighlight } from "./mentionHighlight";

/** How the group's page finds a message to scroll to (its quote card's click). */
/** How long a speaker's next message still reads as part of the same turn: no face or name again. */
const RUN = 5 * 60_000;
/** Messages one page of the main flow holds, and one page of a thread's replies. */
const MAIN_PAGE = 100;
const THREAD_PAGE = 50;
/** How near the top a scroll asks for the page before. */
const NEAR_TOP = 240;

/** Messages put together by id, oldest first: a page loaded earlier and what was pushed meanwhile. */
function mergeMessages(was: GroupMessage[], more: GroupMessage[]): GroupMessage[] {
  const ids = new Set(was.map((m) => m.id));
  const fresh = more.filter((m) => !ids.has(m.id));
  return fresh.length ? [...fresh, ...was].sort((a, b) => a.seq - b.seq) : was;
}

/**
 * Keeping what is in sight in place while a page goes in above it: `hold` notes how far the
 * view is from the bottom just before, and once `rows` change the view is put back there.
 */
function useHoldScroll(scroller: RefObject<HTMLDivElement | null>, rows: unknown) {
  const fromEnd = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && fromEnd.current !== null) el.scrollTop = el.scrollHeight - fromEnd.current;
    fromEnd.current = null;
  }, [rows]);
  return () => {
    const el = scroller.current;
    fromEnd.current = el ? el.scrollHeight - el.scrollTop : null;
  };
}

/** A time line goes before a message after this much quiet (and before the first). */
const PAUSE = 15 * 60_000;

/** Put the caret in a composer: the main one, or the thread's. */
function focusComposer(scope: string) {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`${scope} .cmp [contenteditable=true]`)?.focus());
}

function scrollToMessage(id: string) {
  const el = document.querySelector<HTMLElement>(`.gpage [data-mid="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  el.classList.add("qflash");
  setTimeout(() => el.classList.remove("qflash"), 1400);
}

/**
 * A group's page (bot-group-chat-dev-brief §5, design §6.4): the main flow with every speaker's
 * face and name, a note for each new member and a fuse, threads beside it, the composer with its
 * @ menu, who is thinking, and the settings.
 */
export function GroupPage({ group }: { group: GroupSummary }) {
  const st = useStore();
  const { t } = useTranslation("groups");
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [threads, setThreads] = useState<Record<string, GroupThread>>({});
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState<GroupQuote | null>(null);
  // A seat session's call waiting for the owner (M7's card, wired for it): the group page asks.
  const [approvals, setApprovals] = useState<GroupApprovalParams[]>([]);
  const [preview, setPreview] = useState<GroupFile | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [dock, setDock] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  useMentionHighlight(scroller, mentionNames(group));
  const atEnd = useRef(true);
  const [away, setAway] = useState(false);
  // Whether the main flow has older messages than those loaded, and whether they are on their way.
  const [more, setMore] = useState(false);
  const [paging, setPaging] = useState(false);
  const openId = useRef(group.id);
  openId.current = group.id;
  const thread = st.groupThread;
  const settings = st.groupPanel;

  // The group as it opens: the main flow, and a count under each message that started a thread.
  useEffect(() => {
    let stop = false;
    setLoaded(false);
    setMore(false);
    setPaging(false);
    setMessages([]);
    setThreads({});
    setDraft("");
    setReply(null);
    if (!st.rpc) return;
    st.rpc
      .request("groups/open", { id: group.id, limit: MAIN_PAGE })
      .then((r) => {
        if (stop) return;
        // A message pushed while the page was on its way stays.
        setMessages((was) => mergeMessages(was, r.messages));
        setMore(r.messages.length >= MAIN_PAGE);
        setThreads(Object.fromEntries((r.threads ?? []).map((th) => [th.root, th])));
        setLoaded(true);
        requestAnimationFrame(() => {
          if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
        });
      })
      .catch((e) => !stop && st.show(e instanceof Error ? e.message : String(e), undefined, true));
    return () => {
      stop = true;
    };
  }, [group.id, st.rpc]);

  // A call a seat session waits for, and its answer: attach to that session for it, then detach.
  useEffect(() => {
    if (!st.rpc) return;
    return st.rpc.on("group/approval", (a) => {
      if (a.group_id !== group.id) return;
      setApprovals((was) => (was.some((x) => x.call_id === a.call_id) ? was : [...was, a]));
    });
  }, [st.rpc, group.id]);
  useEffect(() => setApprovals([]), [group.id]);
  // However the page came to another group, the thread open beside it was the last group's.
  const shownGroup = useRef(group.id);
  useEffect(() => {
    if (shownGroup.current === group.id) return;
    shownGroup.current = group.id;
    st.set({ groupThread: null, groupPanel: false });
    setPreview(null);
  }, [group.id, st.set]);
  const answer = async (a: GroupApprovalParams, allow: boolean) => {
    setAnswering(a.call_id);
    try {
      await st.call("session/resume", { session_id: a.session_id });
      await st.call("session/op", { session_id: a.session_id, op: { type: "approval", call_id: a.call_id, decision: allow ? { type: "approve" } : { type: "deny" } } });
      await st.call("session/detach", { session_id: a.session_id }).catch(() => {});
      setApprovals((was) => was.filter((x) => x.call_id !== a.call_id));
    } catch (e) {
      st.show(errorText(e), undefined, true);
    } finally {
      setAnswering(null);
    }
  };
  // New messages, and threads' replies, the moment finx pushes them.
  useEffect(() => {
    if (!st.rpc) return;
    return st.rpc.on("group/message", ({ group_id, message }) => {
      if (group_id !== group.id) return;
      setMessages((was) => (was.some((m) => m.id === message.id) ? was : [...was, message].sort((a, b) => a.seq - b.seq)));
      if (message.thread) {
        setThreads((was) => {
          const old = was[message.thread!];
          const last = { from: message.from, text: message.text.slice(0, 1000), ts: message.ts };
          return { ...was, [message.thread!]: old ? { ...old, replies: old.replies + 1, last } : { root: message.thread!, replies: 1, last } };
        });
      }
    });
  }, [st.rpc, group.id]);

  // Unread while the group is open: only for a window in front, as a bot's conversation.
  const unread = group.unread ?? 0;
  useEffect(() => {
    const read = async () => {
      if (unread === 0 || !document.hasFocus() || (await window.finx?.screenLocked())) return;
      void st.call("groups/read", { id: group.id }).catch(() => {});
    };
    void read();
    window.addEventListener("focus", read);
    const offUnlocked = window.finx?.onScreenUnlocked(() => void read());
    return () => {
      window.removeEventListener("focus", read);
      offUnlocked?.();
    };
  }, [group.id, unread, st.call]);

  // Follow the flow unless the owner scrolled up.
  const main = useMemo(() => messages.filter((m) => !m.thread), [messages]);
  useEffect(() => {
    const el = scroller.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [main, dock]);
  const hold = useHoldScroll(scroller, main);
  // The page before the oldest message loaded; its thread counts join the ones there are.
  const earlier = () => {
    const first = main[0];
    if (!st.rpc || !more || paging || !first) return;
    const id = group.id;
    setPaging(true);
    st.rpc
      .request("groups/open", { id, before_seq: first.seq, limit: MAIN_PAGE })
      .then((r) => {
        if (openId.current !== id) return;
        hold();
        setMessages((was) => mergeMessages(was, r.messages));
        setThreads((was) => ({ ...Object.fromEntries((r.threads ?? []).map((th) => [th.root, th])), ...was }));
        setMore(r.messages.length >= MAIN_PAGE);
      })
      .catch((e) => openId.current === id && st.show(errorText(e), undefined, true))
      .finally(() => openId.current === id && setPaging(false));
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
    if (el.scrollTop < NEAR_TOP) earlier();
  };
  const toEnd = () => {
    const el = scroller.current;
    if (!el) return;
    atEnd.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const send = async (text: string, inThread?: string) => {
    const words = text.trim();
    if (!words) return;
    return st.run(async () => {
      await st.call("groups/send", {
        id: group.id,
        text: words,
        // The quote over the main composer is the main flow's; a thread's reply never carries it.
        ...(reply && !inThread ? { reply_to: reply.id } : {}),
        ...(inThread ? { thread: inThread } : {}),
      });
    });
  };
  const sendMain = async () => {
    const before = draft;
    if (!before.trim()) return;
    // What the owner sends is always followed, wherever they had scrolled to.
    atEnd.current = true;
    if (await send(before)) {
      setDraft("");
      setReply(null);
    }
  };
  const quote = (m: GroupMessage) => {
    setReply({ id: m.id, from: m.from, text: m.text });
    focusComposer(".gpage .dmain");
  };
  const openThread = (root: string) => {
    st.set({ groupThread: root, groupPanel: false });
    focusComposer(".gthread-cmp");
  };
  const openSettings = () => st.set({ groupPanel: !settings, groupThread: null });
  const typing = group.typing ?? [];

  // Esc puts away the nearest thing first: the quote being written, then the thread, then the settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || preview || document.querySelector("dialog[open]")) return;
      if (reply) setReply(null);
      else if (thread) st.set({ groupThread: null });
      else if (settings) st.set({ groupPanel: false });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reply, preview, thread, settings, st.set]);

  return (
    <div className={`spage group gpage ${settings || thread ? "bgopen" : ""}`}>
      <div className="scol">
        <GlassBar className="ctool drag">
          <SidebarToggle />
          <button className="bhead ghead" title={t("head.settings")} aria-expanded={settings} onClick={openSettings}>
            <GroupAvatar members={group.members} size={22} />
            <span className="ghead-n">{group.name}</span>
            <span className="ghead-c">{group.members.length}</span>
            {group.external && (
              <span className="ghead-ext" title={t("head.external")} aria-label={t("head.external")}>
                <Icon name="globe" />
              </span>
            )}
            <Icon name="chevR" className="bhead-go" />
          </button>
          <span className="bhead-gap" />
          <button className="tb" title={t("head.settings")} aria-label={t("head.settings")} aria-pressed={settings} onClick={openSettings}>
            <Icon name="gear" />
          </button>
        </GlassBar>
        <div className="dwrap">
          <div className="dmain">
            <div className="cscroll" ref={scroller} onScroll={onScroll}>
              <div className="dbody gbody" style={{ paddingBottom: dock + 40 } as CSSProperties}>
                {loaded && more && (
                  <div className="tdiv earlier">
                    {paging ? <span className="mini-spin" aria-label={t("page.loadingEarlier")} /> : <button className="link" onClick={earlier}>{t("page.earlier")}</button>}
                  </div>
                )}
                {!loaded ? (
                  <div className="loadrow">
                    <span className="mini-spin" />
                  </div>
                ) : main.length === 0 ? (
                  <div className="bempty">
                    <GroupAvatar members={group.members} size={64} />
                    <h3>{group.name}</h3>
                    <p>{group.note || t("page.empty")}</p>
                  </div>
                ) : (
                  <div className="tr bots gtr" role="log" aria-label={t("page.log")}>
                    {main.map((m, i) => (
                      <MessageRow key={m.id} m={m} prev={main[i - 1]} group={group} thread={threads[m.id]} open={thread === m.id} onThread={() => openThread(m.id)} onQuote={() => quote(m)} onPreview={setPreview} />
                    ))}
                  </div>
                )}
              </div>
            </div>
            <button className={`tobottom ${away ? "on" : ""}`} style={{ "--dock": `${dock}px` } as CSSProperties} aria-label={t("page.toBottom")} title={t("page.toBottom")} tabIndex={away ? 0 : -1} aria-hidden={!away} onClick={toEnd}>
              <Icon name="arrowDown" />
            </button>
            <Composer
              form={{ mode: "bot", above: <Above group={group} typing={typing} reply={reply} onReplyClose={() => setReply(null)} draft={draft} onDraft={setDraft} approval={approvals[0]} answering={answering} onAnswer={answer} />, onHeight: setDock }}
              value={draft}
              onChange={setDraft}
              onSend={() => void sendMain()}
              placeholder={t("page.placeholder")}
              attachments={[]}
              onAttachments={() => {}}
              commands={[]}
              files={false}
            />
          </div>
        </div>
      </div>
      {settings && <GroupPanel group={group} onClose={() => st.set({ groupPanel: false })} />}
      {thread && <ThreadPanel group={group} root={thread} total={threads[thread]?.replies} messages={messages} onClose={() => st.set({ groupThread: null })} onSend={(text) => send(text, thread)} onPreview={setPreview} />}
      {preview && <GroupFilePreview group={group} file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** What sits above the composer: who is thinking, a call waiting for the owner, a quote, and the @ menu. */
function Above({ group, typing, reply, onReplyClose, draft, onDraft, approval, answering, onAnswer }: {
  group: GroupSummary;
  typing: string[];
  reply: GroupQuote | null;
  onReplyClose: () => void;
  draft: string;
  onDraft: (text: string) => void;
  approval?: GroupApprovalParams;
  answering: string | null;
  onAnswer: (a: GroupApprovalParams, allow: boolean) => Promise<void>;
}) {
  const { t } = useTranslation("groups");
  const typingText = typing.length ? t("page.typing", { names: typing.map((id) => memberName(group, id)).join("、") }) : null;
  return (
    <>
      <MentionMenu group={group} draft={draft} onDraft={onDraft} scope=".gpage .dmain" />
      {typingText && (
        <div className="gtyping" role="status">
          <span className="gtyping-faces" aria-hidden="true">
            {typing.slice(0, 3).map((id) => {
              const m = group.members.find((x) => x.bot_id === id);
              return m ? <Avatar key={id} spec={m.avatar} name={m.name} size={22} /> : null;
            })}
          </span>
          <span className="gtyping-t">{typingText}</span>
          <span className="gtyping-dots" aria-hidden="true"><i /><i /><i /></span>
        </div>
      )}
      {approval && <ApprovalCard a={approval} busy={answering === approval.call_id} onAnswer={onAnswer} />}
      {reply && (
        <div className="gquote-draft">
          <span className="gquote-text">
            <span className="gquote-who">{t("page.replyTo", { name: speakerName(reply.from, t("page.you")) })}</span>
            <span className="gquote-words">{quoteLine(reply.text)}</span>
          </span>
          <button className="gquote-x" title={t("page.quoteCancel")} aria-label={t("page.quoteCancel")} onClick={onReplyClose}>
            <Icon name="x" />
          </button>
        </div>
      )}
    </>
  );
}

/**
 * A seat session's call waiting for the owner (design §6.4): what it wants, whose words set it
 * off, and only Allow once or Deny. The rest of M7's confirmation card comes later.
 */
function ApprovalCard({ a, busy, onAnswer }: { a: GroupApprovalParams; busy: boolean; onAnswer: (a: GroupApprovalParams, allow: boolean) => Promise<void> }) {
  const { t } = useTranslation("groups");
  const by = a.cause.kind === "direct" ? a.cause.name ?? t("approval.external") : null;
  return (
    <div className="gappr" role="region" aria-label={t("approval.title", { name: a.name })}>
      <div className="gappr-h">
        <Icon name="shield" className="gappr-i" />
        <b>{t("approval.title", { name: a.name })}</b>
      </div>
      <p className="gappr-sum">{a.summary}</p>
      {a.reason && <p className="gappr-reason">{a.reason}</p>}
      <p className="gappr-cause">{by ? t("approval.cause", { name: by }) : t("approval.causeEarlier")}</p>
      <p className="gappr-text">{a.cause.text}</p>
      <div className="gappr-f">
        <button className="btn" disabled={busy} onClick={() => void onAnswer(a, false)}>{t("approval.deny")}</button>
        <span className="appr-sp" />
        <button className="btn primary" disabled={busy} onClick={() => void onAnswer(a, true)}>{t("approval.allow")}</button>
      </div>
    </div>
  );
}

/**
 * The @ menu: the members whose name matches what is being typed after an `@`. ↑↓ move, ↩ or ⇥
 * picks, Esc puts it away until the next `@`. The keys are caught before the editor's own, and
 * only while the caret is in this menu's composer (`scope`).
 */
function MentionMenu({ group, draft, onDraft, scope }: { group: GroupSummary; draft: string; onDraft: (text: string) => void; scope: string }) {
  const { t } = useTranslation("groups");
  const typing = typingMention(draft);
  const choices = typing ? mentionChoices(group.members, typing.query).slice(0, 6) : [];
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const open = typing !== null && choices.length > 0 && dismissed !== typing.start;
  const query = typing?.query;
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (typing === null) setDismissed(null);
  }, [typing === null]);
  const pick = (name: string) => {
    if (!typing) return;
    onDraft(insertMention(draft, typing, name));
    focusComposer(scope);
  };
  const latest = useRef({ choices, active, pick, typing });
  latest.current = { choices, active, pick, typing };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(document.activeElement instanceof HTMLElement) || !document.activeElement.closest(scope)) return;
      const { choices, active, pick, typing } = latest.current;
      const n = choices.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") setActive((active + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      else if ((e.key === "Enter" && !e.isComposing) || e.key === "Tab") pick(choices[active]!.name);
      else if (e.key === "Escape") setDismissed(typing?.start ?? null);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, scope]);
  if (!open) return null;
  return (
    <div className="gmenu" role="listbox" aria-label={t("mention.title")}>
      <div className="gmenu-h">{t("mention.title")}</div>
      {choices.map((m, i) => (
        <button
          key={m.bot_id}
          className={`gmenu-i ${i === active ? "on" : ""}`}
          role="option"
          aria-selected={i === active}
          tabIndex={-1}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => (e.preventDefault(), pick(m.name))}
        >
          <Avatar spec={m.avatar} name={m.name} size={22} />
          <span className="gmenu-n">{m.name}</span>
          {m.external && <Icon name="globe" className="sm gmenu-ext" />}
        </button>
      ))}
    </div>
  );
}

/** The name over a bubble or a quote card, with the external marker wherever the words come from outside. */
function speakerName(from: GroupMessage["from"], you: string): string {
  return from.kind === "owner" ? you : from.kind === "bot" ? from.name : "";
}

/** Who said it, as one key: the same key twice in a row is one speaker's run. */
function speakerKey(from: GroupMessage["from"]): string {
  return from.kind === "bot" ? `bot:${from.bot_id}` : from.kind;
}

/** A time line before a message, after a quiet spell and before the first. */
function TimeSince({ at, previous }: { at: string; previous?: string }) {
  const now = useNow(60_000);
  const text = timeLine(new Date(at), previous ? new Date(previous) : undefined, now, PAUSE);
  return text ? <div className="tdiv gtdiv">{text}</div> : null;
}

/**
 * A message in the flow or in a thread: a face and a name at the start of a speaker's run, the
 * words, its files, the thread under it, and on hover a small bar to reply in a thread or quote.
 */
function MessageRow({ m, prev, group, thread, open, onThread, onQuote, onPreview }: {
  m: GroupMessage;
  prev?: GroupMessage;
  group: GroupSummary;
  thread?: GroupThread;
  open?: boolean;
  onThread?: () => void;
  onQuote?: () => void;
  onPreview?: (file: GroupFile) => void;
}) {
  const { t } = useTranslation("groups");
  const bots = useLists((l) => l.bots);
  // A face from the group, else from the bots (one that has left keeps its own), else a plain one.
  const face = (id: string) => group.members.find((x) => x.bot_id === id)?.avatar ?? bots.find((b) => b.id === id)?.avatar ?? { kind: "mono" as const, hue: "slate" as const };
  const at = new Date(m.ts);
  const line = <TimeSince at={m.ts} previous={prev?.ts} />;
  if (m.from.kind === "system") {
    return (
      <>
        {line}
        <div className="gsys" data-mid={m.id}>{m.text}</div>
      </>
    );
  }
  const own = m.from.kind === "owner";
  const external = m.from.kind === "bot" && m.from.external;
  const botId = m.from.kind === "bot" ? m.from.bot_id : null;
  const gone = !!botId && !group.members.some((x) => x.bot_id === botId);
  const who = speakerName(m.from, t("page.you"));
  const quiet = prev ? at.getTime() - new Date(prev.ts).getTime() : Infinity;
  const cont = !!prev && prev.from.kind !== "system" && speakerKey(prev.from) === speakerKey(m.from) && quiet < RUN;
  const exact = at.toLocaleString();
  return (
    <>
      {quiet >= PAUSE && line}
      <div className={`gmsg ${own ? "own" : "other"} ${cont ? "cont" : ""} ${gone ? "gone" : ""}`} data-mid={m.id}>
        {!own && (
          <div className="gface">
            {cont ? null : botId ? (
              <Avatar spec={face(botId)} name={who} size={28} />
            ) : null}
          </div>
        )}
        <div className="gmain">
          {!cont && !own && (
            <div className="gsender">
              <span className="gsender-n">{who}</span>
              {gone && <span className="ggone">{t("page.left")}</span>}
              {external && (
                <span className="gext" title={t("head.external")} aria-label={t("head.external")}>
                  <Icon name="globe" className="sm" />
                </span>
              )}
              <time className="gtime" dateTime={m.ts} title={exact}>{hourMinute(at)}</time>
            </div>
          )}
          <div className={`gcontent ${own ? "own" : ""}`}>
            {m.reply_preview && <QuoteCard q={m.reply_preview} you={t("page.you")} />}
            {m.text !== "" && (own ? <div className="bub sel-text" title={exact}>{m.text}</div> : <div className="bbub"><Markdown text={m.text} /></div>)}
            {(m.files ?? []).length > 0 && (
              <div className="gfiles">
                {(m.files ?? []).map((f) => (
                  <button key={f.path} className="gfile" title={f.path} onClick={() => onPreview?.(f)}>
                    <Icon name="file" className="sm" />
                    <span className="gfile-n">{f.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {thread && thread.replies > 0 && onThread && (
            <button className={`gthread-link ${open ? "on" : ""}`} onClick={onThread}>
              <span className="gthread-faces" aria-hidden="true">
                {thread.last?.from.kind === "bot" && (
                  <Avatar spec={face(thread.last.from.bot_id)} name={thread.last.from.name} size={22} />
                )}
              </span>
              <span className="gthread-n">{t("page.threadCount", { count: thread.replies })}</span>
              {thread.last && <span className="gthread-t">{t("page.threadLast", { time: shortTime(new Date(thread.last.ts), new Date()) })}</span>}
              <Icon name="chevR" className="sm gthread-go" />
            </button>
          )}
        </div>
        {(onThread || onQuote) && (
          <div className="gacts" role="toolbar" aria-label={t("page.actions")}>
            {onThread && (
              <button className="gact" title={t("page.replyThread")} aria-label={t("page.replyThread")} onClick={onThread}>
                <Icon name="chats" />
              </button>
            )}
            {onQuote && (
              <button className="gact" title={t("page.quote")} aria-label={t("page.quote")} onClick={onQuote}>
                <Icon name="quote" />
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Quoted words on one line, as read: no Markdown marks, lines run together. */
function quoteLine(text: string): string {
  return text.split("\n").map((l) => plain(l.trim())).filter(Boolean).join(" ");
}

/** The card over a reply: who it quotes, the words, and a click that finds it in the flow. */
function QuoteCard({ q, you }: { q: GroupQuote; you: string }) {
  return (
    <button className="gquote" onClick={() => scrollToMessage(q.id)} title={q.text}>
      <span className="gquote-text">
        <span className="gquote-who">{speakerName(q.from, you)}：</span>
        <span className="gquote-words">{quoteLine(q.text)}</span>
      </span>
    </button>
  );
}

/** A thread beside the main flow (design §6.4): its first message, the replies as they came, and its own composer. */
const threadRoom = () => 360;

/** Who an "@" in a message can name: the members, and the owner. */
const mentionNames = (group: GroupSummary) => ["Owner", ...group.members.map((m) => m.name)];

function ThreadPanel({ group, root, total, messages, onClose, onSend, onPreview }: {
  group: GroupSummary;
  root: string;
  /** How many replies the thread has in all, loaded or not (the main flow's count). */
  total?: number;
  messages: GroupMessage[];
  onClose: () => void;
  onSend: (text: string) => Promise<boolean | void>;
  onPreview: (file: GroupFile) => void;
}) {
  const { t } = useTranslation("groups");
  const st = useStore();
  const [draft, setDraft] = useState("");
  // The thread's own messages, a page at a time from `groups/thread` (the main flow carries none of them).
  const [loaded, setLoaded] = useState<GroupMessage[] | null>(null);
  const [more, setMore] = useState(false);
  const [paging, setPaging] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const shown = useRef(root);
  shown.current = root;
  useEffect(() => {
    let stop = false;
    setLoaded(null);
    setMore(false);
    setPaging(false);
    if (!st.rpc) return;
    st.rpc
      .request("groups/thread", { id: group.id, root, limit: THREAD_PAGE })
      .then((r) => {
        if (stop) return;
        setLoaded(r.messages);
        setMore(threadMessages(r.messages, root).length >= THREAD_PAGE - 1);
      })
      .catch((e) => !stop && (setLoaded([]), st.show(errorText(e), undefined, true)));
    return () => {
      stop = true;
    };
  }, [group.id, root, st.rpc]);
  const replies = useMemo(() => threadMessages(mergeMessages(loaded ?? [], threadMessages(messages, root)), root), [messages, loaded, root]);
  const main = messages.find((m) => m.id === root) ?? loaded?.find((m) => m.id === root);
  const hold = useHoldScroll(scroller, replies);
  // The group's own column keeps room beside the thread; the edge drags it wider or narrower.
  const { panel, resizing, style, grip } = usePanelWidth("finxwork.groupThreadWidth", threadRoom);
  useMentionHighlight(scroller, mentionNames(group));
  const count = Math.max(replies.length, total ?? 0);
  // Each page holds the root as well: a full one is the page size less one reply.
  const earlier = () => {
    const first = replies[0];
    if (!st.rpc || !more || paging || !first) return;
    const at = root;
    setPaging(true);
    st.rpc
      .request("groups/thread", { id: group.id, root, before_seq: first.seq, limit: THREAD_PAGE })
      .then((r) => {
        if (shown.current !== at) return;
        const page = threadMessages(r.messages, at);
        hold();
        setLoaded((was) => mergeMessages(was ?? [], page));
        setMore(page.length >= THREAD_PAGE - 1);
      })
      .catch((e) => shown.current === at && st.show(errorText(e), undefined, true))
      .finally(() => shown.current === at && setPaging(false));
  };
  // To the newest reply when the thread opens and when one comes, not when older ones go in above.
  const lastId = replies.at(-1)?.id;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, root, loaded === null]);
  useEffect(() => setDraft(""), [root]);
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await onSend(text)) setDraft("");
  };
  const onScroll = () => {
    const el = scroller.current;
    if (el && el.scrollTop < NEAR_TOP) earlier();
  };
  return (
    <aside ref={panel} className={`bgp gthread ${resizing ? "resizing" : ""}`} style={style(false)} aria-label={t("page.threadTitle")}>
      <div className="brp-grip no-drag" role="separator" aria-orientation="vertical" aria-label={t("page.threadResize")} tabIndex={0} {...grip} />
      <div className="gthread-top drag">
        <span className="gthread-title">
          {t("page.threadTitle")}
          {count > 0 && <span className="gthread-sub">{t("page.threadCount", { count })}</span>}
        </span>
        <button className="tb" title={t("page.threadClose")} aria-label={t("page.threadClose")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="gthread-scroll" ref={scroller} onScroll={onScroll}>
        {main && (
          <div className="gthread-root">
            <MessageRow m={main} group={group} onPreview={onPreview} />
          </div>
        )}
        <div className="gthread-sep" role="separator">
          {loaded === null ? <span className="mini-spin" /> : <span>{replies.length === 0 ? t("page.threadEmpty") : t("page.threadCount", { count })}</span>}
        </div>
        {more && (
          <div className="tdiv earlier gthread-earlier">
            {paging ? <span className="mini-spin" aria-label={t("page.loadingEarlier")} /> : <button className="link" onClick={earlier}>{t("page.threadEarlier")}</button>}
          </div>
        )}
        {replies.map((m, i) => (
          <MessageRow key={m.id} m={m} prev={replies[i - 1]} group={group} onPreview={onPreview} />
        ))}
      </div>
      <div className="gthread-cmp">
        <MentionMenu group={group} draft={draft} onDraft={setDraft} scope=".gthread-cmp" />
        <Composer
          form={{ mode: "bot", onHeight: () => {} }}
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          placeholder={t("page.threadPlaceholder")}
          attachments={[]}
          onAttachments={() => {}}
          commands={[]}
          files={false}
        />
      </div>
    </aside>
  );
}
