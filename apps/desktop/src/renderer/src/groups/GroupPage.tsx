import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { insertMention, mentionChoices, memberName, threadMessages, typingMention } from "@finx/client";
import type { GroupApprovalParams, GroupFile, GroupMessage, GroupQuote, GroupSummary, GroupThread } from "@finx/protocol";
import { GroupFilePreview } from "./GroupFilePreview";
import { SidebarToggle } from "../components";
import { Composer } from "../composer/Composer";
import { Markdown } from "../session/Markdown";
import { GlassBar } from "../glass";
import { Icon } from "../icons";
import { shortTime } from "../format";
import { errorText, useNow, useStore } from "../store";
import { Avatar } from "../bots/Avatar";
import { GroupAvatar } from "./GroupAvatar";
import { GroupPanel } from "./GroupPanel";

/** How the group's page finds a message to scroll to (its quote card's click). */
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
  const atEnd = useRef(true);
  const thread = st.groupThread;
  const settings = st.groupPanel;

  // The group as it opens: the main flow, and a count under each message that started a thread.
  useEffect(() => {
    let stop = false;
    setLoaded(false);
    setMessages([]);
    setThreads({});
    setDraft("");
    setReply(null);
    if (!st.rpc) return;
    st.rpc
      .request("groups/open", { id: group.id, limit: 100 })
      .then((r) => {
        if (stop) return;
        setMessages(r.messages);
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
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const send = async (text: string, inThread?: string) => {
    const words = text.trim();
    if (!words) return;
    return st.run(async () => {
      await st.call("groups/send", {
        id: group.id,
        text: words,
        ...(reply ? { reply_to: reply.id } : {}),
        ...(inThread ? { thread: inThread } : {}),
      });
    });
  };
  const sendMain = async () => {
    const before = draft;
    if (!before.trim()) return;
    if (await send(before)) {
      setDraft("");
      setReply(null);
    }
  };
  const openThread = (root: string) => st.set({ groupThread: root, groupPanel: false });
  const openSettings = () => st.set({ groupPanel: !settings, groupThread: null });
  const typing = group.typing ?? [];
  return (
    <div className={`spage group gpage ${settings || thread ? "bgopen" : ""}`}>
      <div className="scol">
        <GlassBar className="ctool drag">
          <SidebarToggle />
          <button className="bhead ghead" title={t("head.settings")} aria-expanded={settings} onClick={openSettings}>
            <GroupAvatar members={group.members} size={22} />
            <span className="bhead-n">
              {group.name}
              {group.external && <span className="bhead-h mono">{t("head.external")}</span>}
            </span>
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
                    {main.map((m) => (
                      <MessageRow key={m.id} m={m} group={group} thread={threads[m.id]} onThread={() => openThread(m.id)} onQuote={() => setReply({ id: m.id, from: m.from, text: m.text })} onPreview={setPreview} />
                    ))}
                  </div>
                )}
              </div>
            </div>
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
      {thread && <ThreadPanel group={group} root={thread} messages={messages} onClose={() => st.set({ groupThread: null })} onSend={(text) => send(text, thread)} />}
      {preview && <GroupFilePreview group={group} file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** What sits above the composer: who is thinking, a fuse's line and its continue, a quote, and the @ menu. */
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
      <MentionMenu group={group} draft={draft} onDraft={onDraft} />
      {typingText && (
        <div className="gtyping" role="status">
          <span className="gtyping-dots" aria-hidden="true"><i /><i /><i /></span>
          {typingText}
        </div>
      )}
      {approval && <ApprovalCard a={approval} busy={answering === approval.call_id} onAnswer={onAnswer} />}
      {reply && (
        <div className="gquote-draft">
          <div className="gquote-main">
            <span className="gquote-who">{speakerName(reply.from, t("page.you"))}</span>
            <span className="gquote-text">{reply.text}</span>
          </div>
          <button className="tb" title={t("panel.close")} aria-label={t("panel.close")} onClick={onReplyClose}>
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

/** The @ menu: the members whose name matches what is being typed after an `@`. */
function MentionMenu({ group, draft, onDraft }: { group: GroupSummary; draft: string; onDraft: (text: string) => void }) {
  const { t } = useTranslation("groups");
  const typing = typingMention(draft);
  if (!typing) return null;
  const choices = mentionChoices(group.members, typing.query).slice(0, 6);
  if (choices.length === 0) return null;
  const pick = (name: string) => {
    onDraft(insertMention(draft, typing, name));
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".spage.group .cmp [contenteditable=true]")?.focus());
  };
  return (
    <div className="gmenu" role="listbox" aria-label={t("mention.title")}>
      {choices.map((m) => (
        <button key={m.bot_id} className="gmenu-i" role="option" aria-selected={false} onMouseDown={(e) => (e.preventDefault(), pick(m.name))} onClick={() => pick(m.name)}>
          <Avatar spec={m.avatar} name={m.name} size={22} />
          <span>{m.name}</span>
          {m.external && <Icon name="globe" className="sm" />}
        </button>
      ))}
    </div>
  );
}

/** The name over a bubble or a quote card, with the external marker wherever the words come from outside. */
function speakerName(from: GroupMessage["from"], you: string): string {
  return from.kind === "owner" ? you : from.kind === "bot" ? from.name : "";
}

function MessageRow({ m, group, thread, onThread, onQuote, onPreview }: {
  m: GroupMessage;
  group: GroupSummary;
  thread?: GroupThread;
  onThread: () => void;
  onQuote: () => void;
  onPreview?: (file: GroupFile) => void;
}) {
  const { t } = useTranslation("groups");
  const now = useNow(30_000);
  if (m.from.kind === "system") return <div className="gsys" data-mid={m.id}>{m.text}</div>;
  const own = m.from.kind === "owner";
  const external = m.from.kind === "bot" && m.from.external;
  const botId = m.from.kind === "bot" ? m.from.bot_id : null;
  const who = speakerName(m.from, t("page.you"));
  return (
    <div className={`grow ${own ? "own" : "other"}`} data-mid={m.id}>
      <div className="gface">
        {botId ? (
          <Avatar spec={group.members.find((x) => x.bot_id === botId)?.avatar ?? { kind: "mono", hue: "slate" }} name={who} size={22} />
        ) : (
          <span className="gface-you" aria-hidden="true">{t("page.you").slice(0, 1)}</span>
        )}
      </div>
      <div className="gmain">
        <div className="gsender">
          {who}
          {external && (
            <span className="gext" title={t("head.external")}>
              <Icon name="globe" className="sm" />
            </span>
          )}
          <span className="gtime">{shortTime(now, new Date())}</span>
        </div>
        <div className={`gcontent ${own ? "own" : ""}`}>
          {m.reply_preview && <QuoteCard q={m.reply_preview} you={t("page.you")} />}
          {m.text !== "" && (own ? <div className="bub sel-text">{m.text}</div> : <div className="bbub"><Markdown text={m.text} /></div>)}
          {(m.files ?? []).length > 0 && (
            <div className="gfiles">
              {(m.files ?? []).map((f) => (
                <button key={f.path} className="gfile" title={f.path} onClick={() => onPreview?.(f)}>
                  <Icon name="file" className="sm" />
                  {f.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {thread && thread.replies > 0 && (
          <button className="gthread-link" onClick={onThread}>
            <Icon name="chats" className="sm" />
            {t("page.threadReplies", { count: thread.replies, time: thread.last ? shortTime(new Date(thread.last.ts), new Date()) : "" })}
          </button>
        )}
        <div className="gacts">
          <button className="gact" onClick={onThread}>{t("page.replyThread")}</button>
          <button className="gact" onClick={onQuote}>{t("page.quote")}</button>
        </div>
      </div>
    </div>
  );
}

/** The card over a reply: who it quotes, the words, and a click that finds it in the flow. */
function QuoteCard({ q, you }: { q: GroupQuote; you: string }) {
  return (
    <button className="gquote" onClick={() => scrollToMessage(q.id)} title={q.text}>
      <span className="gquote-who">{speakerName(q.from, you)}</span>
      <span className="gquote-text">{q.text}</span>
    </button>
  );
}

/** A thread beside the main flow (design §6.4): its first message, the replies as they came, and its own composer. */
function ThreadPanel({ group, root, messages, onClose, onSend }: { group: GroupSummary; root: string; messages: GroupMessage[]; onClose: () => void; onSend: (text: string) => Promise<boolean | void> }) {
  const { t } = useTranslation("groups");
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const main = messages.find((m) => m.id === root);
  const replies = threadMessages(messages, root);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await onSend(text)) setDraft("");
  };
  return (
    <aside className="bgp gthread" aria-label={t("page.threadTitle")}>
      <div className="gthread-top">
        <span className="gthread-title">
          <Icon name="chats" className="sm" />
          {t("page.threadTitle")}
        </span>
        <button className="tb" title={t("page.threadClose")} aria-label={t("page.threadClose")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="gthread-scroll" ref={scroller}>
        {main && <MessageRow m={main} group={group} onThread={() => {}} onQuote={() => {}} />}
        {replies.length === 0 ? (
          <p className="gthread-empty">{t("page.threadEmpty")}</p>
        ) : (
          replies.map((m) => <ThreadReply key={m.id} m={m} group={group} />)
        )}
      </div>
      <div className="gthread-cmp">
        <MentionMenu group={group} draft={draft} onDraft={setDraft} />
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

/** A reply in the thread panel: who, what, and no thread line of its own. */
function ThreadReply({ m, group }: { m: GroupMessage; group: GroupSummary }) {
  const { t } = useTranslation("groups");
  if (m.from.kind === "system") return <div className="gsys">{m.text}</div>;
  const who = speakerName(m.from, t("page.you"));
  const own = m.from.kind === "owner";
  const botId = m.from.kind === "bot" ? m.from.bot_id : null;
  return (
    <div className={`grow ${own ? "own" : "other"}`} data-mid={m.id}>
      <div className="gface">
        {botId ? (
          <Avatar spec={group.members.find((x) => x.bot_id === botId)?.avatar ?? { kind: "mono", hue: "slate" }} name={who} size={22} />
        ) : (
          <span className="gface-you" aria-hidden="true">{t("page.you").slice(0, 1)}</span>
        )}
      </div>
      <div className="gmain">
        <div className="gsender">{who}</div>
        <div className="gcontent">
          {m.reply_preview && <QuoteCard q={m.reply_preview} you={t("page.you")} />}
          {m.text !== "" && (own ? <div className="bub">{m.text}</div> : <div className="bbub"><Markdown text={m.text} /></div>)}
        </div>
      </div>
    </div>
  );
}