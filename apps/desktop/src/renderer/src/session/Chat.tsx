import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { addTotals, baseName, conversation, costText, openChain, runningAgents, segments, tokensText, totals, type ListSession, type SessionView, type Step, type TaskChain, type WorkItem } from "@finx/client";
import type { TaskEndItem } from "@finx/protocol";
import { unarchive } from "../actions";
import { SkillTag } from "../composer/SkillNode";
import { pairImages } from "../composer/attachments";
import { Tile } from "../composer/Tile";
import { agoInterval, durationText, messageAgo, timeLine } from "../format";
import { Icon, MarkMotion } from "../icons";
import { useNow, useStore } from "../store";
import { AgentCard, BackgroundLine, ReportCard } from "./Agents";
import { Dock } from "./Dock";
import { FailureCard, PastFailure, RetryCard, useResumeAfterCompact } from "./Failure";
import { DraftMarkdown, Markdown } from "./Markdown";
import { LiveThinking, RunningCalls, ToolRow, Work } from "./Steps";

/**
 * The conversation, newest at the bottom, ending with what the model is
 * still writing; the composer and, while a task runs, its bar sit over the
 * bottom edge.
 */
export function Chat({ s, view, loadEarlier }: { s: ListSession; view: SessionView; loadEarlier: () => Promise<void> }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const steps = useMemo(() => conversation(view), [view]);
  const scroll = useRef<HTMLDivElement>(null);
  const [dock, setDock] = useState(0);
  const retry = view.live?.retry;
  useResumeAfterCompact(s.session_id, view);

  // Earlier history, a page at a time, as the person nears the top. While a page comes in above
  // what they read, it stays where it was: how far it sat from the bottom is taken from the page
  // still on screen, while this render's rows are not in it yet.
  const [paging, setPaging] = useState(false);
  const asking = useRef(false);
  const earlier = () => {
    if (asking.current || !view.before) return;
    asking.current = true;
    setPaging(true);
    loadEarlier().finally(() => {
      asking.current = false;
      setPaging(false);
    });
  };
  const first = useRef(view.entries[0]);
  const fromEnd = useRef<number | null>(null);
  if (view.entries[0] !== first.current && scroll.current && view.entries.includes(first.current)) {
    fromEnd.current = scroll.current.scrollHeight - scroll.current.scrollTop;
  }

  // Follow the conversation: open at its end, and stay there as it grows unless the person scrolled up;
  // scrolled well up, a button takes them back down.
  const atEnd = useRef(true);
  const [away, setAway] = useState(false);
  useLayoutEffect(() => {
    const el = scroll.current;
    first.current = view.entries[0];
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
    else if (el && fromEnd.current !== null) el.scrollTop = el.scrollHeight - fromEnd.current;
    fromEnd.current = null;
    if (el && nearTop(el)) earlier();
  }, [steps, dock, retry]);
  const onScroll = () => {
    const el = scroll.current;
    if (!el) return;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    atEnd.current = below < 80;
    setAway(below > 240);
    if (nearTop(el)) earlier();
  };
  const toEnd = () => {
    const el = scroll.current;
    if (!el) return;
    atEnd.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  // The session's current failure is told once, at the end, with Retry; earlier ones in one quiet line.
  const lastEnd = [...steps].reverse().find((x) => x.kind === "end");
  const working = runningAgents(view).length;
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
          {view.before && (
            <div className="tdiv earlier">
              {paging ? <span className="mini-spin" aria-label={t("chat.loadingEarlier")} /> : <button className="link" onClick={earlier}>{t("chat.earlier")}</button>}
            </div>
          )}
          <div className="tr" role="log" aria-label={t("chat.log")}>
            {steps.map((step, i) => (
              <Row key={step.key} step={step} previous={previousUser(steps, i)} final={finalOf(steps, i)} merged={isMerged(steps, i)} current={step === lastEnd && !!view.failure && !view.live} working={step === lastEnd ? working : 0} sessionId={s.session_id} />
            ))}
            {retry && <RetryCard retry={retry} sessionId={s.session_id} />}
            <Working view={view} steps={steps} />
            <BackgroundLine view={view} />
          </div>
        </div>
      </div>
      <button className={`tobottom ${away ? "on" : ""}`} style={{ "--dock": `${dock}px` } as CSSProperties} aria-label={t("chat.toBottom")} title={t("chat.toBottom")} tabIndex={away ? 0 : -1} aria-hidden={!away} onClick={toEnd}>
        <Icon name="arrowDown" />
      </button>
      <Dock s={s} view={view} onHeight={setDock} />
    </>
  );
}

/** Close enough to the top to ask for earlier history: a page or so ahead, so it is there before the person is. */
const nearTop = (el: HTMLElement) => el.scrollTop < el.clientHeight * 1.5;

/** A call that runs, or waits its turn to: drawn at the end of the conversation, in the working line. */
const runs = (it: WorkItem) => it.kind === "tool" && (it.tool.state === "running" || it.tool.state === "pending");
/** The thinking the model is writing now: drawn in the working line too, and back among the steps once it is done. */
const thinks = (it: WorkItem) => it.kind === "thinking" && it.live;

/**
 * While a task runs, the conversation's last line, beside the mark written
 * over and over, so a slow model or tool still shows it is at work. Its
 * time runs from the owner's message, across the tasks that carry on the
 * work when sub-agents report. While calls run: what runs, one line even
 * for several at once ("Reading 2 files"), which opens to each, and the
 * time. Otherwise a line of its own under what the model writes, with the
 * time and the tokens its finished model calls took: what it does, thinking
 * only while its thinking streams in (its last lines under that line),
 * writing, compacting, or else just working. While
 * it waits on the owner (an approval) or on a retry, which say so
 * themselves, the calls that run stand alone.
 */
function Working({ view, steps }: { view: SessionView; steps: Step[] }) {
  const { t } = useTranslation("session");
  const now = useNow(1000).getTime();
  const live = view.live;
  const chain = useMemo(() => openChain(view), [view.entries, view.agents]);
  const used = live ? (chain.usage ? addTotals(chain.usage, live.usage) : live.usage) : undefined;
  const tokens = useCountUp(used ? totals(used).tokens : 0);
  if (!live) return null;
  const time = <span className="wk-time">{durationText(now - (chain.started ?? live.started))}</span>;
  const tools = steps.flatMap((x) => (x.kind === "work" ? x.items.flatMap((it) => (it.kind === "tool" && runs(it) ? [it.tool] : [])) : []));
  // Several at once read as one line; it opens to each.
  const calls =
    tools.length === 0 ? null
    : tools.length === 1 ? <ToolRow key={tools[0].call_id} tool={tools[0]} after={time} />
    : <RunningCalls key="calls" tools={tools} after={time} />;
  if (live.approvals.length > 0 || live.retry) return calls;
  if (calls) {
    return (
      <div className="working" role="status">
        <MarkMotion size={18} rewrite />
        <div className="wk-now">{calls}</div>
      </div>
    );
  }
  // Writing: its words, or a call's arguments.
  const last = steps.at(-1);
  const end = last?.kind === "work" ? last.items.at(-1) : undefined;
  const writing = (last?.kind === "text" && last.live) || (end?.kind === "tool" && end.tool.state === "streaming");
  // Thinking only while thinking streams in; anything else that is not said (waiting on the model or on sub-agents) is just work.
  const thought = end?.kind === "thinking" && end.live ? end : undefined;
  const doing = live.compacting !== undefined ? "compacting" : writing ? "writing" : thought ? "thinking" : "working";
  const line = (
    <>
      <span className="shimmer">{t(`chat.working.${doing}`)}</span>
      <span className="wk-meta">
        {`· ${durationText(now - (chain.started ?? live.started))}`}
        {tokens > 0 && ` · ${t("chat.tokens", { tokens: tokensText(tokens) })}`}
      </span>
    </>
  );
  return (
    <div className="working" role="status">
      <MarkMotion size={18} rewrite />
      {doing === "thinking" && thought ? (
        <div className="wk-now">
          <LiveThinking text={thought.text}>{line}</LiveThinking>
        </div>
      ) : (
        <div className="wk-line">{line}</div>
      )}
    </div>
  );
}

/** A number that runs up to each larger value in 0.8s, quick then easing, instead of jumping; a smaller one (a new task) and reduced motion set it at once. */
function useCountUp(value: number): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  from.current = shown;
  useEffect(() => {
    const start = from.current;
    if (value <= start || matchMedia("(prefers-reduced-motion: reduce)").matches) return setShown(value);
    const t0 = performance.now();
    let raf = requestAnimationFrame(function step(now) {
      const p = Math.min(1, (now - t0) / 800);
      setShown(Math.round(start + (value - start) * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return shown;
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

/** `working`: the background tasks still working, for the last task end. */
type RowProps = { step: Step; previous: number | undefined; final: EndStep | undefined; merged: boolean; current: boolean; working: number; sessionId: string };

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
    a.working === b.working &&
    a.sessionId === b.sessionId &&
    sameStep(a.step, b.step),
);

function sameStep(a: Step, b: Step): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  switch (a.kind) {
    case "user":
      return a.text === (b as typeof a).text && a.images.length === (b as typeof a).images.length && a.files.length === (b as typeof a).files.length && a.comments.length === (b as typeof a).comments.length && a.quotes.length === (b as typeof a).quotes.length && a.skills.join() === (b as typeof a).skills.join();
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
      return a.launches.length === x.length && a.launches.every((l, i) => l.agent === x[i].agent && l.name === x[i].name && l.description === x[i].description && l.task === x[i].task);
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

function RowView({ step, previous, final, merged, current, working, sessionId }: RowProps) {
  const { t } = useTranslation("session");
  switch (step.kind) {
    case "user": {
      const { pictures, rest } = pairImages([...step.comments, ...step.quotes], step.images);
      const picture = (i: number) => pictures[i] && `data:${pictures[i].mime_type};base64,${pictures[i].data}`;
      return (
        <>
          <TimeLine at={step.ts} previous={previous} />
          <div className="um">
            {(step.images.length > 0 || step.files.length > 0 || step.comments.length > 0 || step.quotes.length > 0) && (
              <div className="um-att">
                {rest.map((im, i) => (
                  <Tile key={i} kind="image" src={`data:${im.mime_type};base64,${im.data}`} />
                ))}
                {step.files.map((f) => (
                  <Tile key={f} kind={/[\\/]$/.test(f) ? "folder" : "file"} path={f} name={baseName(f)} />
                ))}
                {step.comments.map((c, i) => (
                  <Tile key={`web${i}`} kind="web" web={c} shot={picture(i)} />
                ))}
                {step.quotes.map((q, i) => (
                  <Tile key={`doc${i}`} kind="doc" quote={q} shot={picture(step.comments.length + i)} />
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
    }
    case "text":
      return (
        <div className={`am ${final ? "act" : ""}`}>
          {step.live ? <DraftMarkdown text={step.text} /> : <Markdown text={step.text} />}
          {final && <MessageBar text={step.text} at={step.ts} task={finished(final) ? <TaskTook end={final} started={previous} /> : undefined} />}
        </div>
      );
    case "work":
      // Calls that run, and the thinking in progress, are drawn in the working line at the end.
      return <Work items={step.items.filter((it) => !runs(it) && !thinks(it))} live={step.live} />;
    case "agents":
      return <AgentCard launches={step.launches} />;
    case "report":
      return <ReportCard step={step} />;
    case "end":
      if (merged) return null;
      return <TaskEnd end={step.end} chain={step.chain} started={previous} current={current} working={working} sessionId={sessionId} />;
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
  // The clock only redraws it; the time is read now. When a message turns a minute old it moves to the
  // minute clock, whose last tick can be most of a minute behind, and would read as "just now" again.
  useNow(agoInterval(at));
  return (
    <time dateTime={at.toISOString()} title={at.toLocaleString()}>
      {messageAgo(at, new Date())}
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
function TaskEnd({ end, chain, started, current, working, sessionId }: { end: TaskEndItem; chain?: TaskChain; started: number | undefined; current: boolean; working: number; sessionId: string }) {
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
  return current ? <FailureCard error={end.error ?? undefined} working={working} sessionId={sessionId} /> : <PastFailure error={end.error ?? undefined} />;
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
