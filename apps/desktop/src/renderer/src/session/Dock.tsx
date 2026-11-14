import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { changesFilesAfter, docViewingBlock, pendingApproval, quoteForSend, type ListSession, type MessageQuote, type SessionView } from "@finx/client";
import type { QueuedInput, UserMessage } from "@finx/protocol";
import type { Attachment } from "../composer/attachments";
import { addAttachments, fromInput, toInput } from "../composer/attachments";
import { useComposerInbox } from "../composer/inbox";
import { Composer } from "../composer/Composer";
import { useCommands } from "../composer/skills";
import { viewingBlock } from "../files/state";
import { useStore } from "../store";
import { Approval } from "./Approval";
import { Notice } from "./Notice";
import { Queue } from "./Queue";
import { OfferedTab, YoursWaitCard } from "./Yours";

type Draft = { text: string; attachments: Attachment[] };

/** What the owner had written in each session and not sent yet. */
const drafts = new Map<string, Draft>();

/**
 * A sent message being written again (message-resend-design §5): nothing of it is finx's business
 * until it is sent. Which message, how the tray calls it, the draft set aside for it, and whether
 * its new words are on their way.
 */
type Again = { id: string; label: string; stash: Draft; sending: boolean };

const agains = new Map<string, Again>();

/** The message of a session being written again, if any. */
export const writingAgain = (sessionId: string) => agains.get(sessionId)?.id;

/** What stopped or failed tasks handed back that is in a composer already: a page opened again does not add it twice. */
const handed = new WeakSet<UserMessage[]>();

/** Notices the owner closed, as "session id:time" (the kernel sending one again shows it again). */
const closed = new Set<string>();

/**
 * The bottom of a session's page: the composer in its session form (it
 * stops a running task too), with the session's key notice, a pending
 * approval, and what waits for the task above it. Its height goes to the
 * conversation, which keeps clear of it.
 *
 * `takeBack` is where the conversation's rows ask for a sent message to be written again;
 * `onAgain` tells them which one is, `onFind` finds it among them, and `onResent` follows the
 * conversation to its end.
 */
export function Dock({ s, view, onHeight, takeBack: askAgain, onAgain, onFind, onResent, onFindQuote, quoteGone }: {
  s: ListSession;
  view: SessionView;
  onHeight: (h: number) => void;
  takeBack: RefObject<(messageId: string) => void>;
  onAgain: (messageId: string | undefined) => void;
  onFind: (messageId: string) => void;
  onResent: () => void;
  /** A quote's tile was clicked: show the words where they were said (message-quote-design §4.4). */
  onFindQuote?: (q: MessageQuote) => void;
  /** Whether a quote's message is out of the conversation (§5). */
  quoteGone?: (q: MessageQuote) => boolean;
}) {
  const { t } = useTranslation("session");
  const st = useStore();
  const id = s.session_id;
  const [draft, setDraft] = useState(() => drafts.get(id) ?? { text: "", attachments: [] });
  const change = (d: Draft) => {
    setDraft(d);
    drafts.set(id, d);
  };
  const [again, setAgain] = useState(() => agains.get(id));
  const writeAgain = (a: Again | undefined) => {
    if (a) agains.set(id, a);
    else agains.delete(id);
    setAgain(a);
    onAgain(a?.id);
  };
  // A sent message comes back to the composer, attachments and all; what was being written waits.
  askAgain.current = (messageId) => {
    const now = agains.get(id);
    const entry = view.entries.find((e) => e.type === "message" && e.message_id === messageId);
    if (now?.sending || entry?.type !== "message" || entry.message.role !== "user") return;
    const back = fromInput(entry.message.content, view);
    const label = back.text.split("\n")[0] || t("queued.attachments", { count: back.attachments.length });
    writeAgain({ id: messageId, label, stash: now?.stash ?? drafts.get(id) ?? { text: "", attachments: [] }, sending: false });
    change(back);
  };
  const stopWritingAgain = () => {
    const now = agains.get(id);
    if (!now || now.sending) return false;
    writeAgain(undefined);
    change(now.stash);
    return true;
  };
  // The message went by another hand: what was written stays, as a draft, with the one set aside.
  const keepAsDraft = (now: Again) => {
    writeAgain(undefined);
    const d = drafts.get(id) ?? { text: "", attachments: [] };
    change({ text: [d.text.trim(), now.stash.text.trim()].filter(Boolean).join("\n\n"), attachments: addAttachments(d.attachments, now.stash.attachments) });
    st.show(t("resend.gone"));
  };
  // Before what is handed back below, which joins the draft this puts back.
  const rewound = view.rewound;
  useEffect(() => {
    const now = agains.get(id);
    if (!now || !rewound?.gone.includes(now.id)) return;
    if (!now.sending || rewound.message_id !== now.id) return keepAsDraft(now);
    writeAgain(undefined);
    change(now.stash);
  }, [rewound]);
  // Refused: nothing changed, and the words are still here.
  useEffect(() => {
    const now = agains.get(id);
    if (!view.refused || !now?.sending) return;
    writeAgain({ ...now, sending: false });
    st.show(t("resend.refused"), undefined, true);
  }, [view.refused]);
  // A new snapshot (finx came back, or detached this window): no event will say what became of the
  // message. Still in the conversation, it can be sent again; gone, and sent from here, it went.
  const attached = useRef(view.attached);
  useEffect(() => {
    if (attached.current === view.attached) return;
    attached.current = view.attached;
    const now = agains.get(id);
    if (!now) return;
    const there = view.entries.some((e) => e.type === "message" && e.message_id === now.id);
    if (there || view.before) {
      if (now.sending) writeAgain({ ...now, sending: false });
      return;
    }
    if (!now.sending) return keepAsDraft(now);
    writeAgain(undefined);
    change(now.stash);
  }, [view.attached]);
  // Leaving the page while its words are on their way: they are finx's now, and the draft comes back.
  useEffect(
    () => () => {
      const now = agains.get(id);
      if (!now?.sending) return;
      agains.delete(id);
      drafts.set(id, now.stash);
    },
    [],
  );
  // Parts of pages from the browser panel, quotes from the document column.
  useComposerInbox(id, (more) => {
    const d = drafts.get(id) ?? { text: "", attachments: [] };
    change({ ...d, attachments: addAttachments(d.attachments, more) });
  });
  // Messages back from the kernel go before what is being written, a blank line between, with
  // what they carry; while a sent message is being written again, before the draft set aside.
  const putBack = (messages: UserMessage[]) => {
    const back = messages.map((m) => fromInput(m.content, view));
    const now = agains.get(id);
    const d = now?.stash ?? drafts.get(id) ?? { text: "", attachments: [] };
    const text = [...back.map((b) => b.text), d.text.trim()].filter(Boolean).join("\n\n");
    const attachments = back.reduce<Attachment[]>((list, b) => addAttachments(list, b.attachments), []);
    const merged = { text, attachments: addAttachments(attachments, d.attachments) };
    if (now) writeAgain({ ...now, stash: merged });
    else change(merged);
  };
  // What a stopped or failed task handed back.
  useEffect(() => {
    const returned = view.returned;
    if (!returned?.length || handed.has(returned)) return;
    handed.add(returned);
    putBack(returned);
    st.show(t("queued.returned", { count: returned.length }));
  }, [view.returned]);
  // Messages taken back from the queue, to edit or to delete: the kernel says which went, and
  // one that joined the conversation first was too late to take back.
  const taking = useRef(new Map<string, { q: QueuedInput; edit: boolean }>());
  const takeBack = (q: QueuedInput, edit: boolean) => {
    taking.current.set(q.id, { q, edit });
    void st.op(id, { type: "withdraw", id: q.id });
  };
  useEffect(() => {
    for (const [qid, { q, edit }] of taking.current) {
      if (view.withdrawn === qid) {
        taking.current.delete(qid);
        if (edit) putBack([q.message]);
        else st.show(t("queued.deleted"), () => void st.op(id, { type: "prompt", input: q.message.content, mode: q.mode }));
      } else if (!view.queued.some((x) => x.id === qid)) {
        taking.current.delete(qid);
        st.show(t("queued.delivered"));
      }
    }
  }, [view.withdrawn, view.queued]);

  const live = view.live;
  const asking = pendingApproval(view);
  const info = view.info;
  const commands = useCommands({ session_id: id });
  const [, redraw] = useState(0);
  // Bypass-permissions was agreed to when it was switched on (the composer's picker asks), so
  // finx's warning on loading such a session is not shown again.
  const notice = view.notices.findLast((n) => n.code !== "bypass_permissions" && !closed.has(`${id}:${n.ts}`));
  const close = (n: NonNullable<typeof notice>) => {
    closed.add(`${id}:${n.ts}`);
    redraw((x) => x + 1);
  };
  // While a task runs ↩ interjects, ⌥↩ queues; a message written again goes back in the conversation.
  const send = async (followUp: boolean) => {
    const sent = draft;
    const writing = agains.get(id);
    if (!writing) change({ text: "", attachments: [] });
    const input = toInput(sent.text, sent.attachments.map((a) => (a.kind === "said" ? { ...a, quote: quoteForSend(a.quote, view) } : a)));
    // What the file panel shows goes along, so "this page" or "these cells" means something (§7.4).
    const viewing = viewingBlock(id, st.files);
    if (viewing && input.length) input.push(viewing);
    await st.giveOffered(id, input);
    if (writing) {
      // The words stay here until finx answers: `session_rewound`, or a refusal.
      writeAgain({ ...writing, sending: true });
      onResent();
      const ok = await st.op(id, { type: "resend", message_id: writing.id, input });
      const now = agains.get(id);
      if (!ok && now) writeAgain({ ...now, sending: false });
      return;
    }
    const ok = await st.op(id, { type: "prompt", input, mode: live ? (followUp ? "follow_up" : "steer") : undefined });
    if (!ok) change(sent);
  };
  const why = [t(again?.sending ? "resend.sending" : "resend.hint"), again && !again.sending && changesFilesAfter(view, again.id) ? t("resend.hintFiles") : "", again && !again.sending && live ? t("resend.hintRunning") : ""].join("");
  return (
    <Composer
      form={{
        mode: "session",
        // What is written goes back in the conversation: no stop, no interjecting.
        running: live !== null && !again,
        onStop: () => st.op(id, { type: "interrupt" }),
        onEditLast: () => {
          const last = view.queued.at(-1);
          if (last && !again) takeBack(last, true);
          return last !== undefined && !again;
        },
        again: again?.id,
        onEscape: stopWritingAgain,
        locked: again?.sending,
        above: (
          <>
            {notice && <Notice key={`${notice.code}:${notice.ts}`} notice={notice} onClose={() => close(notice)} />}
            <YoursWaitCard sessionId={id} />
            <OfferedTab />
            {asking && <Approval key={`${asking.agent?.id ?? ""}/${asking.approval.call_id}`} sessionId={id} view={view} />}
            {(view.queued.length > 0 || again) && (
              <Queue
                items={view.queued}
                approving={(live?.approvals.length ?? 0) > 0}
                onNow={() => void st.op(id, { type: "steer_now" })}
                onInterject={(q) => void st.op(id, { type: "requeue", id: q.id, mode: "steer" })}
                onEdit={again ? undefined : (q) => takeBack(q, true)}
                onDelete={(q) => takeBack(q, false)}
                again={again && { label: again.label, why, onFind: () => onFind(again.id), onCancel: () => void stopWritingAgain() }}
              />
            )}
          </>
        ),
        onHeight,
      }}
      value={draft.text}
      onChange={(text) => change({ ...draft, text })}
      attachments={draft.attachments}
      onAttachments={(attachments) => change({ ...draft, attachments })}
      onQuote={onFindQuote}
      quoteGone={quoteGone}
      onSend={send}
      commands={commands}
      canSend={!s.archived && !again?.sending}
      placeholder={s.archived ? t("composer.archived") : again ? t("resend.placeholder") : live ? t("composer.steer") : t("composer.reply")}
      settings={{
        permission: info.permission_mode,
        onPermission: (m) => st.op(id, { type: "set_permission_mode", mode: m }),
        model: info.model,
        thinking: info.thinking,
        models: st.models,
        onModel: (ref) => void st.op(id, { type: "set_model", model: ref }),
        onThinking: (l) => st.op(id, { type: "set_model", model: info.model, thinking: l }),
      }}
    />
  );
}

