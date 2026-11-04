import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { docViewingBlock, type ListSession, type SessionView } from "@finx/client";
import type { QueuedInput, UserMessage } from "@finx/protocol";
import type { Attachment } from "../composer/attachments";
import { addAttachments, fromInput, toInput } from "../composer/attachments";
import { useComposerInbox } from "../composer/inbox";
import { Composer } from "../composer/Composer";
import { useCommands } from "../composer/skills";
import { viewingDoc } from "../files/state";
import { useStore } from "../store";
import { Approval } from "./Approval";
import { Notice } from "./Notice";
import { Queue } from "./Queue";
import { OfferedTab, YoursWaitCard } from "./Yours";

/** What the owner had written in each session and not sent yet. */
const drafts = new Map<string, { text: string; attachments: Attachment[] }>();

/** What stopped or failed tasks handed back that is in a composer already: a page opened again does not add it twice. */
const handed = new WeakSet<UserMessage[]>();

/** Notices the owner closed, as "session id:time" (the kernel sending one again shows it again). */
const closed = new Set<string>();

/**
 * The bottom of a session's page: the composer in its session form (it
 * stops a running task too), with the session's key notice, a pending
 * approval, and what waits for the task above it. Its height goes to the
 * conversation, which keeps clear of it.
 */
export function Dock({ s, view, onHeight }: { s: ListSession; view: SessionView; onHeight: (h: number) => void }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const id = s.session_id;
  const [draft, setDraft] = useState(() => drafts.get(id) ?? { text: "", attachments: [] });
  const change = (d: { text: string; attachments: Attachment[] }) => {
    setDraft(d);
    drafts.set(id, d);
  };
  // Parts of pages from the browser panel, quotes from the document column.
  useComposerInbox(id, (more) => {
    const d = drafts.get(id) ?? { text: "", attachments: [] };
    change({ ...d, attachments: addAttachments(d.attachments, more) });
  });
  // Messages back from the kernel go before what is being written, a blank line between, with what they carry.
  const putBack = (messages: UserMessage[]) => {
    const back = messages.map((m) => fromInput(m.content));
    const d = drafts.get(id) ?? { text: "", attachments: [] };
    const text = [...back.map((b) => b.text), d.text.trim()].filter(Boolean).join("\n\n");
    const attachments = back.reduce<Attachment[]>((list, b) => addAttachments(list, b.attachments), []);
    change({ text, attachments: addAttachments(attachments, d.attachments) });
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
  // While a task runs ↩ interjects, ⌥↩ queues.
  const send = async (followUp: boolean) => {
    const sent = draft;
    change({ text: "", attachments: [] });
    const input = toInput(sent.text, sent.attachments);
    // The PDF the file panel shows goes along, so "this page" means something (§7.4).
    const tab = st.files ? viewingDoc(id) : undefined;
    if (tab && input.length) input.push(docViewingBlock(tab.info.path, tab.info.doc_id, tab.page, tab.info.pages ?? 0));
    await st.giveOffered(id, input);
    const ok = await st.op(id, { type: "prompt", input, mode: live ? (followUp ? "follow_up" : "steer") : undefined });
    if (!ok) change(sent);
  };
  return (
    <Composer
      form={{
        mode: "session",
        running: live !== null,
        onStop: () => st.op(id, { type: "interrupt" }),
        onEditLast: () => {
          const last = view.queued.at(-1);
          if (last) takeBack(last, true);
          return last !== undefined;
        },
        above: (
          <>
            {notice && <Notice key={`${notice.code}:${notice.ts}`} notice={notice} onClose={() => close(notice)} />}
            <YoursWaitCard sessionId={id} />
            <OfferedTab />
            {live !== null && live.approvals.length > 0 && <Approval key={live.approvals[0].call_id} s={s} view={view} />}
            {view.queued.length > 0 && (
              <Queue
                items={view.queued}
                approving={(live?.approvals.length ?? 0) > 0}
                onNow={() => void st.op(id, { type: "steer_now" })}
                onInterject={(q) => void st.op(id, { type: "requeue", id: q.id, mode: "steer" })}
                onEdit={(q) => takeBack(q, true)}
                onDelete={(q) => takeBack(q, false)}
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
      onSend={send}
      commands={commands}
      canSend={!s.archived}
      placeholder={s.archived ? t("composer.archived") : live ? t("composer.steer") : t("composer.reply")}
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

