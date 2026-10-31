import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { approvalPreview, argsOf, describe, toolObject, type ApprovalPreview, type ListSession, type SessionView } from "@finx/client";
import type { ApprovalDecision, SiteGrant } from "@finx/protocol";
import { pageCommand } from "../commands";
import { toolDo } from "../format";
import { Mark } from "../icons";
import { useStore } from "../store";
import { Code } from "./Code";

/**
 * A tool call waiting for the owner (Op::Approval), popped up right above
 * the composer in its shape: what finx wants to do and why it asks, the
 * command or the change itself, and the answers as buttons, one click each.
 * Deny opens a line for why, which goes back to the model; stopping the
 * whole task is the composer's Stop. Keys: ⌘↩ (the menu's Approve) allows
 * once from anywhere; outside the composer ↩ allows, 2 allows for the
 * session, Esc (or 3) denies. Several waiting are answered in order.
 * A browser call offers each proposed site grant as its own button; 2 picks
 * the first.
 */
export function Approval({ s, view }: { s: ListSession; view: SessionView }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const live = view.live!;
  const a = live.approvals[0];
  const tool = live.tools.find((x) => x.call_id === a.call_id) ?? { ...describe(a.name, argsOf(a.args), view.info.cwd), name: a.name };
  const preview = approvalPreview(a.name, argsOf(a.args), a.summary);
  const [denying, setDenying] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const give = async (decision: ApprovalDecision) => {
    if (busy) return;
    setBusy(true);
    await st.op(s.session_id, { type: "approval", call_id: a.call_id, decision });
    setBusy(false);
  };
  const deny = () => give({ type: "deny", feedback: feedback.trim() || undefined });

  // The keys work unless the person types elsewhere or another layer is open.
  const grants = a.proposed_grants ?? [];
  const keys = useRef({ give, denying, blocked: false, grants: false });
  keys.current = { give, denying, blocked: st.sheet !== null || st.searching, grants: grants.length > 0 };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (k.blocked || k.denying || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")) return;
      if (e.key === "Enter" || e.key === "1") k.give({ type: "approve" });
      else if (e.key === "2") k.give({ type: "approve_for_session", grant: k.grants ? 0 : undefined });
      else if (e.key === "Escape" || e.key === "3") setDenying(true);
      else return;
      e.preventDefault();
    };
    const onCommand = (e: Event) => (e as CustomEvent).detail === "approve" && keys.current.give({ type: "approve" });
    document.addEventListener("keydown", onKey);
    window.addEventListener(pageCommand, onCommand);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(pageCommand, onCommand);
    };
  }, []);
  useEffect(() => {
    if (denying) field.current?.focus();
  }, [denying]);

  const question = tool.category === "execute" ? t("approval.runCommand") : t("approval.useTool", { verb: toolDo(tool.category), object: toolObject(tool) });
  const rule = a.proposed_rule?.prefix.join(" ");
  return (
    <div className="appr" role="region" aria-label={t("approval.label")}>
      <div className="appr-h">
        <Mark size={16} />
        <b>{question}</b>
        {a.reason && <span className="why" title={a.reason}>{a.reason}</span>}
        {live.approvals.length > 1 && <span className="qx-tag">{t("approval.queue", { n: 1, total: live.approvals.length })}</span>}
      </div>
      <Preview p={preview} />
      <div className="appr-f">
        {denying ? (
          <>
            <input
              ref={field}
              className="field"
              placeholder={t("approval.feedback")}
              aria-label={t("approval.feedback")}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") (e.preventDefault(), deny());
                else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setDenying(false));
              }}
            />
            <button className="btn" onClick={() => setDenying(false)}>{t("approval.cancel")}</button>
            <button className="btn danger" disabled={busy} onClick={deny}>
              {t("approval.deny")}
              <span className="kret">↩</span>
            </button>
          </>
        ) : (
          <>
            <button className="btn" disabled={busy} onClick={() => setDenying(true)}>{t("approval.denyWhy")}</button>
            <span className="appr-sp" />
            {grants.length > 0 ? (
              grants.map((g, i) => (
                <button key={i} className="btn" disabled={busy} title={grantTitle(g, t)} onClick={() => give({ type: "approve_for_session", grant: i })}>
                  {grantLabel(g, t)}
                </button>
              ))
            ) : (
              <button className="btn" disabled={busy} title={rule ? t("approval.sessionRule", { rule }) : t("approval.sessionDesc")} onClick={() => give({ type: "approve_for_session" })}>
                {t("approval.session")}
              </button>
            )}
            <button className="btn primary" disabled={busy} onClick={() => give({ type: "approve" })}>
              {t("approval.once")}
              <span className="kret">⌘↩</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

type T = ReturnType<typeof useTranslation<"session">>["t"];

/** A site grant as a button: the site by host, "any site" with its risk. */
function grantLabel(g: SiteGrant, t: T): string {
  if (g.origin === "*") return t("approval.grantAnySite");
  const site = g.origin.replace(/^https:\/\//, "");
  return g.authority === "act" ? t("approval.grantAct", { site }) : t("approval.grantNavigate", { site });
}

function grantTitle(g: SiteGrant, t: T): string {
  return g.origin === "*" ? t("approval.grantAnySiteRisk") : t("approval.grantDesc");
}

/** The call itself: a command coloured as shell, a change as removed and added lines, or what it writes. */
function Preview({ p }: { p: ApprovalPreview }) {
  const { t } = useTranslation("session");
  switch (p.kind) {
    case "command":
      return (
        <pre className="appr-pre sel-text">
          <Code text={p.text} lang="bash" />
        </pre>
      );
    case "diff":
      return (
        <pre className="appr-pre diff sel-text">
          {p.lines.map((l, i) => (
            <span key={i} className={l.sign === "+" ? "add" : "del"}>
              {l.sign} {l.text}
            </span>
          ))}
          {p.more > 0 && <span className="more">{t("approval.more", { count: p.more })}</span>}
        </pre>
      );
    case "content":
      return (
        <pre className="appr-pre sel-text">
          {p.lines.join("\n")}
          {p.more > 0 && <span className="more">{t("approval.more", { count: p.more })}</span>}
        </pre>
      );
    case "args":
      return <pre className="appr-pre sel-text">{p.text}</pre>;
  }
}
