import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { clockText, elapsedSeconds, runningAgents, taskGists, tokensText, totals, type AgentLaunch, type AgentView, type SessionView, type Step } from "@finx/client";
import type { AgentStatus } from "@finx/protocol";
import { durationText } from "../format";
import { Icon } from "../icons";
import { useNow, useStore } from "../store";
import { Markdown } from "./Markdown";

// Sub-agents in the conversation: the agents a reply started, each as it is
// now; the reports they send back; and, at the conversation's end, how many
// still work, which opens the background panel.

/** How long an agent has worked: its round so far while it runs, else how long its last round took. */
export function agentTime(a: AgentView, now: number): string {
  if (a.status === "running") return clockText(elapsedSeconds(a.since, now));
  return a.elapsed_ms !== undefined ? durationText(a.elapsed_ms) : "";
}

/** The status glyph: none while it works (its name shimmers instead), a check when done, a pause when stopped. */
export function AgentGlyph({ status }: { status: AgentStatus | undefined }) {
  const { t } = useTranslation("session");
  if (status === undefined || status === "running") return <span className="gl" />;
  const icon = status === "completed" ? "check" : status === "interrupted" ? "pause" : "x";
  const tone = status === "completed" ? "ok" : status === "interrupted" ? "int" : "bad";
  return (
    <span className={`gl ${tone}`} role="img" aria-label={t(`agents.status.${status}`)}>
      <Icon name={icon} />
    </span>
  );
}

/** Opens the background panel at an agent. */
export function useShowAgent(): (id: string | undefined) => void {
  const st = useStore();
  return (id) => st.set({ background: true, agent: id ?? st.agent });
}

/** What spawn_agent started: one row per agent, live; a click shows its work in the background panel. An
 * agent the session does not know (its call has a result, but no agent came with it) has no status. */
export function AgentCard({ launches }: { launches: AgentLaunch[] }) {
  const { t } = useTranslation("session");
  const now = useNow(1000).getTime();
  const show = useShowAgent();
  const gists = taskGists(launches.map((l) => l.task));
  return (
    <div className="agc">
      <div className="agc-h">
        <Icon name="bot" />
        <span>{t("agents.launched", { count: launches.length })}</span>
      </div>
      {launches.map((l, i) => {
        const a = l.agent;
        const status = a?.status ?? (l.starting ? "running" : undefined);
        const tone = status === "completed" ? "ok" : status === "interrupted" ? "int" : status === "running" || status === undefined ? "" : "bad";
        const asks = (a?.view.live?.approvals.length ?? 0) > 0;
        return (
          <button key={l.call_id} className="agc-r" title={t("agents.open")} onClick={() => show(a?.id)}>
            <AgentGlyph status={a?.status} />
            {l.description ? (
              // Its label first; the handle finx calls it by, quietly after.
              <>
                <span className={`agc-d ${status === "running" ? "shimmer" : ""}`}>{l.description}</span>
                <span className="agc-k">{a?.name ?? l.name}</span>
              </>
            ) : (
              <>
                <span className={`agc-n ${status === "running" ? "shimmer" : ""}`}>{a?.name ?? l.name}</span>
                <span className="agc-g">{gists[i]}</span>
              </>
            )}
            <span className={`agc-s ${tone}`}>
              {status && <span>{t(asks ? "agents.status.awaiting_approval" : `agents.status.${status}`)}</span>}
              {a && <span className="tm">{agentTime(a, now)}</span>}
            </span>
            <Icon name="chevR" className="go" />
          </button>
        );
      })}
    </div>
  );
}

/** A sub-agent's report, where it reached the conversation: its first lines, the rest on request. */
export function ReportCard({ step }: { step: Extract<Step, { kind: "report" }> }) {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const show = useShowAgent();
  const a = step.agent;
  // Time and tokens are the agent's as it is now: a report from an earlier round of it goes without them.
  const latest = a !== undefined && a.status === step.status;
  const sum = latest && a.usage ? totals(a.usage) : null;
  const meta = [latest && a.elapsed_ms !== undefined ? durationText(a.elapsed_ms) : "", sum && sum.tokens > 0 ? `${tokensText(sum.tokens)} tokens` : ""].filter(Boolean);
  const tone = step.status === "completed" ? "ok" : step.status === "interrupted" ? "int" : "bad";
  const long = !step.no_reply && (step.text.split("\n").length > 2 || step.text.length > 140);
  return (
    <div className="rpc">
      <div className="rpc-h">
        <Icon name="bot" className="sm" />
        <span>
          <Trans t={t} i18nKey="agents.report" values={{ name: a?.description || step.name }} components={{ b: <b className={a?.description ? "who label" : "who"} /> }} />
        </span>
        <span className={`chip ${tone}`}>{t(`agents.status.${step.status}`)}</span>
        {meta.length > 0 && <span className="meta">{meta.join(" · ")}</span>}
      </div>
      <div className={`rpc-b ${long && !open ? "clamp" : ""}`}>
        {/* No reply: the report's words are a note for the model; say it in the window's words. */}
        {step.no_reply ? <p className="rpc-none">{t(`agents.noReply.${step.status === "interrupted" ? "interrupted" : "completed"}`)}</p> : <Markdown text={step.text} />}
      </div>
      <div className="rpc-f">
        {long && (
          <button className="link quiet" onClick={() => setOpen(!open)}>
            {open ? t("agents.collapse") : t("agents.expand")}
          </button>
        )}
        <button className="link" onClick={() => show(step.agent_id)}>
          {t("agents.process")}
          <Icon name="chevR" />
        </button>
      </div>
    </div>
  );
}

/** What a sub-agent sent while it worked, where it reached the conversation: drawn like a report, but its work goes on. */
export function AgentMessageCard({ step }: { step: Extract<Step, { kind: "agent_message" }> }) {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const show = useShowAgent();
  const a = step.agent;
  const long = step.text.split("\n").length > 2 || step.text.length > 140;
  return (
    <div className="rpc">
      <div className="rpc-h">
        <Icon name="bot" className="sm" />
        <span>
          <Trans t={t} i18nKey="agents.message" values={{ name: a?.description || step.name }} components={{ b: <b className={a?.description ? "who label" : "who"} /> }} />
        </span>
      </div>
      <div className={`rpc-b ${long && !open ? "clamp" : ""}`}>
        <Markdown text={step.text} />
      </div>
      <div className="rpc-f">
        {long && (
          <button className="link quiet" onClick={() => setOpen(!open)}>
            {open ? t("agents.collapse") : t("agents.expand")}
          </button>
        )}
        <button className="link" onClick={() => show(step.agent_id)}>
          {t("agents.process")}
          <Icon name="chevR" />
        </button>
      </div>
    </div>
  );
}

/** At the conversation's end, under the working line: how many background tasks still work (or wait after a stop); opens the panel. */
export function BackgroundLine({ view }: { view: SessionView }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const running = runningAgents(view).length;
  const stopped = view.agents.filter((a) => a.status === "interrupted").length;
  if (running === 0 && stopped === 0) return null;
  const on = st.background ? "on" : "";
  return (
    <button className={`bgind ${running === 0 ? "int" : ""} ${on}`} aria-expanded={st.background} onClick={() => st.set({ background: !st.background })}>
      <span>{running > 0 ? t("agents.running", { count: running }) : t("agents.stopped", { count: stopped })}</span>
      <Icon name="chevR" />
    </button>
  );
}
