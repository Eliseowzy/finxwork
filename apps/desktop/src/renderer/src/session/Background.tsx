import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
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
 * The background panel: a column of the window on the right, flush with its top, on the
 * content's own ground, with no cards or borders inside. The session's background tasks
 * (sub-agents for now) are rows like the sidebar's sessions: a working one's name runs, a
 * stopped or failed one has a dot. The selected one's work opens under its row, as its own
 * conversation: finx's brief and messages, its steps one per line, its report at the end,
 * following the end while it works.
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
    <aside className="bgp" aria-label={t("background.title")}>
      <div className="bgp-top drag">
        <h3>{t("background.title")}</h3>
        {running > 0 && (
          <button className="qb danger" onClick={() => st.op(s.session_id, { type: "interrupt" })}>
            {t("background.stopAll")}
          </button>
        )}
        <button className="tb" aria-label={t("background.close")} title={t("background.close")} onClick={() => st.set({ background: false })}>
          <Icon name="x" />
        </button>
      </div>
      <div className="bgp-list">
        <div className="grp-h">
          <span className="gt">{sub}</span>
          <span className="sp" />
          {tokens > 0 && <span className="n">{t("background.tokens", { tokens: tokensText(tokens) })}</span>}
        </div>
        {view.agents.map((a, i) => (
          <Fragment key={a.id}>
            <Row a={a} gist={gists[i]} selected={sel?.id === a.id} now={now} />
            {sel?.id === a.id && <Process s={s} a={a} />}
          </Fragment>
        ))}
      </div>
    </aside>
  );
}

/** What an agent has used: its finished tasks and the one it runs. */
function agentTokens(a: AgentView): number {
  return totals(a.view.live ? addTotals(a.view.usage, a.view.live.usage) : a.view.usage).tokens;
}

/** One agent, as the sidebar shows a session: its name, running while it works; how long, or a dot when it stopped or failed; a line of its task. */
function Row({ a, gist, selected, now }: { a: AgentView; gist: string; selected: boolean; now: number }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const running = a.status === "running";
  const dot = a.status === "interrupted" ? "w" : a.status === "failed" || a.status === "closed" ? "c" : "";
  return (
    <button className={`srow ${selected ? "sel" : ""}`} aria-pressed={selected} title={t(`agents.status.${a.status}`)} onClick={() => st.set({ agent: selected ? null : a.id })}>
      <span className="smain">
        <span className="sl1">
          <span className={`stitle ${running ? "run" : ""}`}>
            {a.name}
            {running && (
              <>
                <span className="shine" data-t={a.name} aria-hidden="true" />
                <span className="shine band" data-t={a.name} aria-hidden="true" />
              </>
            )}
          </span>
          <span className={`smeta ${dot}`}>
            {dot ? (
              <>
                <span className={`sdot ${dot}`} />
                {t(`agents.status.${a.status}`)}
              </>
            ) : (
              agentTime(a, now)
            )}
          </span>
        </span>
        <span className="sl2">
          <span className="sl2t">{gist}</span>
        </span>
      </span>
    </button>
  );
}

/** The selected agent's work, under its row: its own conversation, read-only, following its end while it works. */
function Process({ s, a }: { s: ListSession; a: AgentView }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const steps = useMemo(() => conversation(a.view), [a.view]);
  const box = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  // Opened from a row low in the list: bring it into view.
  useLayoutEffect(() => {
    box.current?.scrollIntoView({ block: "nearest" });
  }, []);
  useLayoutEffect(() => {
    const el = log.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [steps]);
  const firstUser = steps.findIndex((x) => x.kind === "user");
  return (
    <div className="bgp-work" ref={box}>
      <div className="grp-h">
        <span className="gt">{t("background.process")}</span>
        <span className="sp" />
        {a.status === "running" && (
          <button className="qb danger" onClick={() => st.op(s.session_id, { type: "agent_interrupt", agent: a.id })}>
            {t("background.stop")}
          </button>
        )}
      </div>
      <div
        className="bgp-log"
        ref={log}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollTop + el.clientHeight > el.scrollHeight - 40;
        }}
      >
        {steps.map((step, i) => (
          <ProcessRow key={step.key} step={step} brief={i === firstUser} started={startedBefore(steps, i)} />
        ))}
        {a.status === "interrupted" && <p className="bgp-note int">{t("background.interruptedNote")}</p>}
      </div>
    </div>
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
      if (e.outcome === "failed") return <p className="bgp-note bad">{t("background.failedLine", { message: e.error?.message ?? "" })}</p>;
      const u = totals(e.usage ?? { per_model: {} });
      const parts = [t("background.done"), started !== undefined && e.ts > started ? durationText(e.ts - started) : "", u.tokens > 0 ? `${tokensText(u.tokens)} tokens` : ""].filter(Boolean);
      return (
        <p className="bgp-done">
          <Icon name="check" className="sm" />
          <span>{parts.join(" · ")}</span>
        </p>
      );
    }
    case "note":
      return <p className="bgp-note">{step.note.note === "compaction" ? t("chat.compacted", { before: step.note.tokens_before, after: step.note.tokens_after }) : step.note.note === "context" ? t("chat.context", { percent: step.note.window ? Math.round((step.note.tokens / step.note.window) * 100) : 0, used: tokensText(step.note.tokens), size: tokensText(step.note.window) }) : step.note.message}</p>;
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
    <div className="bgp-said">
      <span className="bgp-cap">{caption}</span>
      <p className={`sel-text ${long && !open ? "clamp" : ""}`}>{text}</p>
      {long && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? t("background.collapse") : t("background.expand")}
        </button>
      )}
    </div>
  );
}
