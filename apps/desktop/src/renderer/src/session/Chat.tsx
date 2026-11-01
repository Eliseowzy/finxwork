import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { baseName, conversation, costText, segments, tokensText, totals, type ListSession, type SessionView, type Step, type TaskChain } from "@finx/client";
import type { TaskEndItem } from "@finx/protocol";
import { unarchive } from "../actions";
import { SkillTag } from "../composer/SkillNode";
import { Tile } from "../composer/Tile";
import { agoInterval, durationText, messageAgo, timeLine } from "../format";
import { Icon } from "../icons";
import { useNow, useStore } from "../store";
import { AgentCard, BackgroundLine, ReportCard } from "./Agents";
import { Dock } from "./Dock";
import { FailureCard, PastFailure, RetryCard, useResumeAfterCompact } from "./Failure";
import { DraftMarkdown, Markdown } from "./Markdown";
import { Work } from "./Steps";

/**
 * The conversation, newest at the bottom, ending with what the model is
 * still writing; the composer and, while a task runs, its bar sit over the
 * bottom edge.
 */
export function Chat({ s, view }: { s: ListSession; view: SessionView }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const steps = useMemo(() => conversation(view), [view]);
  const scroll = useRef<HTMLDivElement>(null);
  const [dock, setDock] = useState(0);
  const retry = view.live?.retry;
  useResumeAfterCompact(s.session_id, view);

  // Follow the conversation: open at its end, and stay there as it grows unless the person scrolled up.
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [steps, dock, retry]);
  const onScroll = () => {
    const el = scroll.current;
    if (el) atEnd.current = el.scrollTop + el.clientHeight > el.scrollHeight - 80;
  };

  // The session's current failure is told once, at the end, with Retry; earlier ones in one quiet line.
  const lastEnd = [...steps].reverse().find((x) => x.kind === "end");
  return (
    <>
      <div className="cscroll" ref={scroll} onScroll={onScroll}>
        <div className="dbody" style={{ paddingBottom: dock + 40 }}>
          {s.archived && (
            <div className="anote">
              <Icon name="archive" className="sm" />
              {t("chat.archived")}
              <button className="link" onClick={() => unarchive(st, s)}>{t("chat.unarchive")}</button>
            </div>
          )}
          {view.before && <div className="tdiv">{t("chat.earlier")}</div>}
          <div className="tr" role="log" aria-label={t("chat.log")}>
            {steps.map((step, i) => (
              <Row key={step.key} step={step} previous={previousUser(steps, i)} final={finalOf(steps, i)} merged={isMerged(steps, i)} current={step === lastEnd && !!view.failure && !view.live} sessionId={s.session_id} />
            ))}
            {retry && <RetryCard retry={retry} sessionId={s.session_id} />}
            <BackgroundLine view={view} />
          </div>
        </div>
      </div>
      <Dock s={s} view={view} onHeight={setDock} />
    </>
  );
}

/** When the owner's message before steps[i] was sent (for time lines and how long a task took). */
function previousUser(steps: Step[], i: number): number | undefined {
  for (let j = i - 1; j >= 0; j--) {
    const x = steps[j];
    if (x.kind === "user") return x.ts;
  }
  return undefined;
}

type EndStep = Extract<Step, { kind: "end" }>;

/** The end of the task when steps[i] is the model's last words of one that has ended: only those get the time and Copy. */
function finalOf(steps: Step[], i: number): EndStep | undefined {
  if (steps[i].kind !== "text") return undefined;
  for (let j = i + 1; j < steps.length; j++) {
    const x = steps[j];
    if (x.kind !== "note") return x.kind === "end" ? x : undefined;
  }
  return undefined;
}

/** A task that simply finished: what it took goes under its last words, and its end draws no line of its own. */
const finished = (end: EndStep) => end.end.outcome === "completed" && (!end.end.reason || end.end.reason === "done");

/** Whether steps[i] is such an end, after the model's last words. */
function isMerged(steps: Step[], i: number): boolean {
  const end = steps[i];
  if (end.kind !== "end" || !finished(end)) return false;
  for (let j = i - 1; j >= 0; j--) if (steps[j].kind !== "note") return finalOf(steps, j) === end;
  return false;
}

type RowProps = { step: Step; previous: number | undefined; final: EndStep | undefined; merged: boolean; current: boolean; sessionId: string };

/**
 * A row renders again only when what it shows changed: the steps are made
 * anew from the session's state each time, but what they hold is shared.
 */
const Row = memo(
  RowView,
  (a, b) =>
    a.previous === b.previous &&
    (a.final === b.final || (!!a.final && !!b.final && sameStep(a.final, b.final))) &&
    a.merged === b.merged &&
    a.current === b.current &&
    a.sessionId === b.sessionId &&
    sameStep(a.step, b.step),
);

function sameStep(a: Step, b: Step): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  switch (a.kind) {
    case "user":
      return a.text === (b as typeof a).text && a.images.length === (b as typeof a).images.length && a.files.length === (b as typeof a).files.length && a.comments.length === (b as typeof a).comments.length && a.skills.join() === (b as typeof a).skills.join();
    case "text":
      return a.text === (b as typeof a).text && a.live === (b as typeof a).live;
    case "work": {
      const x = (b as typeof a).items;
      return (
        a.live === (b as typeof a).live &&
        a.items.length === x.length &&
        a.items.every((it, i) => {
          const y = x[i];
          if (it.kind !== y.kind) return false;
          if (it.kind === "thinking") return y.kind === "thinking" && it.text === y.text && it.live === y.live;
          return y.kind === "tool" && it.tool.state === y.tool.state && it.tool.result === y.tool.result && it.tool.progress === y.tool.progress && it.tool.title === y.tool.title;
        })
      );
    }
    case "agents": {
      const x = (b as typeof a).launches;
      return a.launches.length === x.length && a.launches.every((l, i) => l.agent === x[i].agent && l.name === x[i].name && l.task === x[i].task);
    }
    case "report":
      return a.text === (b as typeof a).text && a.agent === (b as typeof a).agent && a.status === (b as typeof a).status;
    case "end": {
      const c = (b as typeof a).chain;
      return a.end === (b as typeof a).end && a.chain?.usage === c?.usage && a.chain?.agents === c?.agents && a.chain?.started === c?.started;
    }
    case "note":
      return a.note === (b as typeof a).note;
  }
}

function RowView({ step, previous, final, merged, current, sessionId }: RowProps) {
  const { t } = useTranslation("session");
  switch (step.kind) {
    case "user":
      return (
        <>
          <TimeLine at={step.ts} previous={previous} />
          <div className="um">
            {(step.images.length > 0 || step.files.length > 0 || step.comments.length > 0) && (
              <div className="um-att">
                {step.images.map((im, i) => (
                  <Tile key={i} kind="image" src={`data:${im.mime_type};base64,${im.data}`} />
                ))}
                {step.files.map((f) => (
                  <Tile key={f} kind={/[\\/]$/.test(f) ? "folder" : "file"} path={f} name={baseName(f)} />
                ))}
                {step.comments.map((c, i) => (
                  <Tile key={`web${i}`} kind="web" name={c.comment || c.text || `<${c.tag}>`} web={c} />
                ))}
              </div>
            )}
            {step.text !== "" && (
              <div className="bub sel-text">
                <Words text={step.text} skills={step.skills} />
              </div>
            )}
            <MessageBar text={step.text} at={step.ts} mine />
          </div>
        </>
      );
    case "text":
      return (
        <div className={`am ${final ? "act" : ""}`}>
          {step.live ? <DraftMarkdown text={step.text} /> : <Markdown text={step.text} />}
          {final && <MessageBar text={step.text} at={step.ts} task={finished(final) ? <TaskTook end={final} started={previous} /> : undefined} />}
        </div>
      );
    case "work":
      return <Work items={step.items} live={step.live} />;
    case "agents":
      return <AgentCard launches={step.launches} />;
    case "report":
      return <ReportCard step={step} />;
    case "end":
      if (merged) return null;
      return <TaskEnd end={step.end} chain={step.chain} started={previous} current={current} sessionId={sessionId} />;
    case "note":
      return step.note.note === "compaction" ? (
        <div className="tnote">{t("chat.compacted", { before: kilo(step.note.tokens_before), after: kilo(step.note.tokens_after) })}</div>
      ) : step.note.note === "context" ? (
        <div className="tnote">{t("chat.context", { percent: step.note.window ? Math.round((step.note.tokens / step.note.window) * 100) : 0, used: tokensText(step.note.tokens), size: tokensText(step.note.window) })}</div>
      ) : (
        <div className="tnote warn">{step.note.message}</div>
      );
  }
}

const kilo = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/** A time line before a message, for the first one and after a pause. */
function TimeLine({ at, previous }: { at: number; previous: number | undefined }) {
  const now = useNow(60_000);
  const text = timeLine(new Date(at), previous === undefined ? undefined : new Date(previous), now);
  return text ? <div className="tdiv">{text}</div> : null;
}

/**
 * Under a message on hover (the model's only once its task ended): Copy, on
 * the edge the message keeps to, and beside it, quieter, how long ago it was
 * written (the full time on hover) and, under the model's last words, what
 * its task took. The owner's messages keep to the right, so Copy comes last.
 */
function MessageBar({ text, at, task, mine }: { text: string; at: number; task?: ReactNode; mine?: boolean }) {
  const { t } = useTranslation("session");
  const [done, setDone] = useState(false);
  const copy = (
    <button
      className="tb"
      aria-label={t("chat.copy")}
      title={t("chat.copy")}
      onClick={() => navigator.clipboard.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}
    >
      <Icon name={done ? "check" : "copy"} className="sm" />
    </button>
  );
  const meta = (
    <span className="msg-meta">
      <MessageTime at={new Date(at)} />
      {task}
    </span>
  );
  return <div className="msg-act">{mine ? <>{meta}{copy}</> : <>{copy}{meta}</>}</div>;
}

/** What a task took, after the time under its last words: how long, its sub-agents, tokens and cost. */
function TaskTook({ end, started }: { end: EndStep; started: number | undefined }) {
  const parts = useTaskParts(end.end, end.chain, started);
  return <>{parts.map((part) => <span key={part}> · {part}</span>)}</>;
}

/** How long a task (or a piece of work over several, with its sub-agents) took, and what it used. */
function useTaskParts(end: TaskEndItem, chain: TaskChain | undefined, started: number | undefined): string[] {
  const { t } = useTranslation("session");
  const from = chain?.started ?? started;
  const u = totals((chain ? chain.usage : end.usage) ?? { per_model: {} });
  return [
    from !== undefined && end.ts > from ? t("chat.took", { time: durationText(end.ts - from) }) : "",
    chain && chain.agents > 0 ? t("chat.agents", { count: chain.agents }) : "",
    u.tokens > 0 ? t("chat.tokens", { tokens: kilo(u.tokens) }) : "",
    ...u.costs.filter((c) => c.total > 0).map(costText),
  ].filter(Boolean);
}

function MessageTime({ at }: { at: Date }) {
  const now = useNow(agoInterval(at));
  return (
    <time dateTime={at.toISOString()} title={at.toLocaleString()}>
      {messageAgo(at, now)}
    </time>
  );
}

/**
 * Where a task ended, when that is not told under the model's last words: a
 * quiet line when it went well (a task with no words of its own, as a
 * compaction), a word when it stopped early, the failure as a card. A piece
 * of work that took several tasks or sub-agents is told once, at its end, as
 * a whole.
 */
function TaskEnd({ end, chain, started, current, sessionId }: { end: TaskEndItem; chain?: TaskChain; started: number | undefined; current: boolean; sessionId: string }) {
  const { t } = useTranslation("session");
  const parts = useTaskParts(end, chain, started);
  if (end.outcome === "interrupted") return <div className="tnote">{t("chat.interrupted")}</div>;
  if (end.outcome === "completed") {
    if (end.reason && end.reason !== "done") return <div className="tnote">{t(`chat.ended.${end.reason}`)}</div>;
    return (
      <div className="donebar">
        <Icon name="check" className="sm" />
        <span>{[t("chat.done"), ...parts].join(" · ")}</span>
      </div>
    );
  }
  return current ? <FailureCard error={end.error ?? undefined} sessionId={sessionId} /> : <PastFailure error={end.error ?? undefined} />;
}

/** A message's words, its skill mentions drawn as tags (the text copied is still `/skill:name`). */
function Words({ text, skills }: { text: string; skills: string[] }) {
  if (skills.length === 0) return <>{text}</>;
  return (
    <>
      {segments(text, skills).map((part, i) =>
        part.skill ? (
          <span key={i} className="skill-tag-host">
            <SkillTag name={part.skill} />
            <span className="skill-tag-text">{part.text}</span>
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
