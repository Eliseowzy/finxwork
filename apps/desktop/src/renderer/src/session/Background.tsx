import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addTotals, agentBrief, agentTaskOf, conversation, runningAgents, taskGists, tokensText, totals,
  type AgentView, type ListSession, type SessionView, type Step,
} from "@finx/client";
import { durationText } from "../format";
import { Icon } from "../icons";
import { useNow, useStore } from "../store";
import { agentTime } from "./Agents";
import { Markdown } from "./Markdown";
import { Work } from "./Steps";

/**
 * The background card: in the info card's place, over the conversation's top right under its own
 * bar, the same glass card and width, so the tasks read as the session's own. The session's
 * background tasks (sub-agents for now) are rows like the sidebar's sessions: a working one's name
 * runs, a stopped or failed one has a dot. A row opens the agent's work in the card's place, as its
 * own conversation: finx's brief and messages, its steps one per line, its report at the end,
 * following the end while it works; back returns to the list.
 */
export function Background({ s, view }: { s: ListSession; view: SessionView }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const now = useNow(1000).getTime();
  const count = (...states: AgentView["status"][]) => view.agents.filter((a) => states.includes(a.status)).length;
  const running = runningAgents(view).length;
  const done = count("completed");
  const stopped = count("interrupted");
  const failed = count("failed", "closed");
  const parts = [
    running > 0 && t("background.running", { count: running }),
    done > 0 && t("background.completed", { count: done }),
    stopped > 0 && t("background.interrupted", { count: stopped }),
    failed > 0 && t("background.failed", { count: failed }),
  ].filter(Boolean);
  const sub = view.agents.length === 0 ? t("background.none") : done === view.agents.length ? t("background.allDone") : parts.join(" · ");
  const tokens = view.agents.reduce((n, a) => n + agentTokens(a), 0);
  const gists = useMemo(() => taskGists(view.agents.map((a) => agentTaskOf(view, a))), [view.entries, view.agents]);
  const sel = view.agents.find((a) => a.id === st.agent);
  return (
    <div className="insp-stack bgc-stack" role="complementary" aria-label={t("background.title")}>
      <section className="insp bgc">
        {sel ? (
          <Process key={sel.id} s={s} a={sel} now={now} />
        ) : (
          <>
            <div className="bgc-h">
              <h3>{t("background.title")}</h3>
              {running > 0 && (
                <button className="qb danger" onClick={() => st.op(s.session_id, { type: "interrupt" })}>
                  {t("background.stopAll")}
                </button>
              )}
            </div>
            <div className="bgc-sub">
              <span>{sub}</span>
              {tokens > 0 && <span className="n">{t("background.tokens", { tokens: tokensText(tokens) })}</span>}
            </div>
            <div className="bgc-list">
              {view.agents.map((a, i) => (
                <Row key={a.id} s={s} a={a} gist={gists[i]} now={now} />
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/** What an agent has used: its finished tasks and the one it runs. */
function agentTokens(a: AgentView): number {
  return totals(a.view.live ? addTotals(a.view.usage, a.view.live.usage) : a.view.usage).tokens;
}

/**
 * One agent, as the sidebar shows a session: its label, running while it works; how long, or a dot
 * when it stopped or failed; under it the handle finx calls it by (agents from before labels: their
 * name, and a line of their task). A working one's time gives way on hover to its stop, as a
 * sidebar row's to its menu.
 */
function Row({ s, a, gist, now }: { s: ListSession; a: AgentView; gist: string; now: number }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const running = a.status === "running";
  const label = a.description || a.name;
  const open = () => st.set({ agent: a.id });
  return (
    <div
      className={`srow ${running ? "has-act" : ""}`}
      role="button"
      tabIndex={0}
      title={t(`agents.status.${a.status}`)}
      onClick={open}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), open())}
    >
      <span className="smain">
        <span className="sl1">
          <span className={`stitle ${running ? "run" : ""}`}>
            {label}
            {running && (
              <>
                <span className="shine" data-t={label} aria-hidden="true" />
                <span className="shine band" data-t={label} aria-hidden="true" />
              </>
            )}
          </span>
          <Meta a={a} now={now} />
          {running && <StopButton s={s} a={a} className="rowact stop" />}
        </span>
        <span className="sl2">
          {a.description ? <span className="sl2t k">{a.name}</span> : <span className="sl2t">{gist}</span>}
        </span>
      </span>
    </div>
  );
}

/** Stops one agent (the session and its other agents go on). */
function StopButton({ s, a, className }: { s: ListSession; a: AgentView; className: string }) {
  const { t } = useTranslation("session");
  const st = useStore();
  return (
    <button
      className={className}
      title={t("background.stop")}
      aria-label={t("background.stop")}
      onClick={(e) => {
        e.stopPropagation();
        st.op(s.session_id, { type: "agent_interrupt", agent: a.id });
      }}
    >
      <Icon name="stop" className="fill" />
    </button>
  );
}

/** How an agent stands, at a row's right: how long, or a dot when it stopped or failed. */
function Meta({ a, now }: { a: AgentView; now: number }) {
  const { t } = useTranslation("session");
  const asks = (a.view.live?.approvals.length ?? 0) > 0;
  const dot = asks || a.status === "interrupted" ? "w" : a.status === "failed" || a.status === "closed" ? "c" : "";
  return (
    <span className={`smeta ${dot}`}>
      {dot ? (
        <>
          <span className={`sdot ${dot}`} />
          {t(asks ? "agents.status.awaiting_approval" : `agents.status.${a.status}`)}
        </>
      ) : (
        agentTime(a, now)
      )}
    </span>
  );
}

/** The selected agent's work, in the card's place: its label and back to the list, then its own conversation, read-only, following its end while it works. */
function Process({ s, a, now }: { s: ListSession; a: AgentView; now: number }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const steps = useMemo(() => conversation(a.view), [a.view]);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = log.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [steps]);
  const firstUser = steps.findIndex((x) => x.kind === "user");
  const label = a.description || a.name;
  return (
    <>
      <div className="bgc-h">
        <button className="bgc-btn" title={t("background.back")} aria-label={t("background.back")} onClick={() => st.set({ agent: null })}>
          <Icon name="chevL" />
        </button>
        <h3 className="bgc-name" title={label}>{label}</h3>
        {a.status === "running" && <StopButton s={s} a={a} className="bgc-btn stop" />}
      </div>
      <div className="bgc-sub">
        {a.description && <span className="k">{a.name}</span>}
        <Meta a={a} now={now} />
      </div>
      <div
        className="bgc-log"
        ref={log}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollTop + el.clientHeight > el.scrollHeight - 40;
        }}
      >
        {steps.map((step, i) => (
          <ProcessRow key={step.key} step={step} brief={i === firstUser} started={startedBefore(steps, i)} />
        ))}
        {a.status === "interrupted" && <p className="bgc-note int">{t("background.interruptedNote")}</p>}
      </div>
    </>
  );
}

/** When the message before steps[i] was sent: how long the task that ends there took. */
function startedBefore(steps: Step[], i: number): number | undefined {
  for (let j = i - 1; j >= 0; j--) {
    const x = steps[j];
    if (x.kind === "user") return x.ts;
  }
  return undefined;
}

function ProcessRow({ step, brief, started }: { step: Step; brief: boolean; started: number | undefined }) {
  const { t } = useTranslation("session");
  switch (step.kind) {
    case "user":
      return brief ? <Said caption={t("background.brief")} text={agentBrief(step.text)} folds /> : <Said caption={t("background.message")} text={step.text} />;
    case "text":
      return (
        <div className="am">
          <Markdown text={step.text} />
        </div>
      );
    case "work":
      return <Work items={step.items} live={step.live} flat />;
    case "end": {
      const e = step.end;
      if (e.outcome === "interrupted") return null;
      if (e.outcome === "failed") return <p className="bgc-note bad">{t("background.failedLine", { message: e.error?.message ?? "" })}</p>;
      const u = totals(e.usage ?? { per_model: {} });
      const parts = [t("background.done"), started !== undefined && e.ts > started ? durationText(e.ts - started) : "", u.tokens > 0 ? `${tokensText(u.tokens)} tokens` : ""].filter(Boolean);
      return (
        <p className="bgc-done">
          <Icon name="check" className="sm" />
          <span>{parts.join(" · ")}</span>
        </p>
      );
    }
    case "note":
      return <p className="bgc-note">{step.note.note === "compaction" ? t("chat.compacted", { before: step.note.tokens_before, after: step.note.tokens_after }) : step.note.note === "context" ? t("chat.context", { percent: step.note.window ? Math.round((step.note.tokens / step.note.window) * 100) : 0, used: tokensText(step.note.tokens), size: tokensText(step.note.window) }) : step.note.message}</p>;
    default:
      return null;
  }
}

/** finx speaking to the agent: who says it, then its words in plain text; a long brief folds to three lines. */
function Said({ caption, text, folds = false }: { caption: string; text: string; folds?: boolean }) {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const long = folds && (text.split("\n").length > 3 || text.length > 120);
  return (
    <div className="bgc-said">
      <span className="bgc-cap">{caption}</span>
      <p className={`sel-text ${long && !open ? "clamp" : ""}`}>{text}</p>
      {long && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? t("background.collapse") : t("background.expand")}
        </button>
      )}
    </div>
  );
}
