import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ListSession, SessionView } from "@finx/client";
import type { Attachment } from "../composer/attachments";
import { toInput } from "../composer/attachments";
import { Composer } from "../composer/Composer";
import { useCommands } from "../composer/skills";
import { useStore } from "../store";
import { Approval } from "./Approval";
import { Notice } from "./Notice";

/** What the owner had written in each session and not sent yet. */
const drafts = new Map<string, { text: string; attachments: Attachment[] }>();

/** Notices the owner closed, as "session id:time" (the kernel sending one again shows it again). */
const closed = new Set<string>();

/**
 * Sessions whose bypass warning the owner acknowledged. finx warns each time it loads a session in
 * bypass mode (every launch of the app), so "Got it" is kept for the session, across launches,
 * until it leaves bypass mode: turning it on again warns again. Kept in this window's storage.
 */
const ackKey = "finxwork.bypassAcknowledged";
function acknowledged(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(ackKey) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function acknowledge(id: string, on: boolean) {
  const all = acknowledged();
  if (all.has(id) === on) return;
  if (on) all.add(id);
  else all.delete(id);
  try {
    localStorage.setItem(ackKey, JSON.stringify([...all]));
  } catch {
    // Without storage it is asked again next launch.
  }
}

/**
 * The bottom of a session's page: the composer in its session form (it
 * stops a running task too), with the session's key notice and a pending
 * approval above it. Its height goes to the conversation, which keeps clear
 * of it.
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
  // What an interrupt handed back goes back into an empty composer.
  const returned = view.returned?.map((m) => m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n")).join("\n\n");
  useEffect(() => {
    if (returned && !drafts.get(id)?.text) change({ text: returned, attachments: [] });
  }, [returned]);

  const live = view.live;
  const info = view.info;
  const commands = useCommands({ session_id: id });
  const [, redraw] = useState(0);
  const bypass = info?.permission_mode === "bypass-permissions";
  useEffect(() => {
    if (info && !bypass) acknowledge(id, false);
  }, [id, !!info, bypass]);
  const notice = view.notices.findLast((n) => !closed.has(`${id}:${n.ts}`) && !(n.code === "bypass_permissions" && acknowledged().has(id)));
  const close = (n: NonNullable<typeof notice>) => {
    closed.add(`${id}:${n.ts}`);
    if (n.code === "bypass_permissions") acknowledge(id, true);
    redraw((x) => x + 1);
  };
  const send = async (followUp: boolean) => {
    const sent = draft;
    change({ text: "", attachments: [] });
    const input = toInput(sent.text, sent.attachments);
    const ok = await st.op(id, { type: "prompt", input, mode: live ? (followUp ? "follow_up" : "steer") : undefined });
    if (!ok) change(sent);
  };
  return (
    <Composer
      form={{
        mode: "session",
        running: live !== null,
        onStop: () => st.op(id, { type: "interrupt" }),
        above: (
          <>
            {notice && <Notice key={`${notice.code}:${notice.ts}`} s={s} notice={notice} onClose={() => close(notice)} />}
            {live !== null && live.approvals.length > 0 && <Approval key={live.approvals[0].call_id} s={s} view={view} />}
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
        onModel: (ref) => st.op(id, { type: "set_model", model: ref }),
        onThinking: (l) => st.op(id, { type: "set_model", model: info.model, thinking: l }),
      }}
    />
  );
}
