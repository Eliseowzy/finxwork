import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { baseName, conversation, costText, segments, totals, type ListSession, type SessionView, type Step, type TaskChain } from "@finx/client";
import type { TaskEndItem } from "@finx/protocol";
import { unarchive } from "../actions";
import { keyEvent } from "../composer/KeySetup";
import { SkillTag } from "../composer/SkillNode";
import { Tile } from "../composer/Tile";
import { agoInterval, durationText, failureAdvice, failureTitle, messageAgo, timeLine } from "../format";
import { Icon } from "../icons";
import { useNow, useStore } from "../store";
import { AgentCard, BackgroundLine, ReportCard } from "./Agents";
import { Dock } from "./Dock";
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

  // Follow the conversation: open at its end, and stay there as it grows unless the person scrolled up.
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [steps, dock]);
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
              <Row key={step.key} step={step} previous={previousUser(steps, i)} current={step === lastEnd && !!view.failure && !view.live} sessionId={s.session_id} />
            ))}
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

type RowProps = { step: Step; previous: number | undefined; current: boolean; sessionId: string };

/**
 * A row renders again only when what it shows changed: the steps are made
 * anew from the session's state each time, but what they hold is shared.
 */
const Row = memo(RowView, (a, b) => a.previous === b.previous && a.current === b.current && a.sessionId === b.sessionId && sameStep(a.step, b.step));

function sameStep(a: Step, b: Step): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  switch (a.kind) {
    case "user":
      return a.text === (b as typeof a).text && a.images.length === (b as typeof a).images.length && a.files.length === (b as typeof a).files.length && a.skills.join() === (b as typeof a).skills.join();
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

function RowView({ step, previous, current, sessionId }: RowProps) {
  const { t } = useTranslation("session");
  switch (step.kind) {
    case "user":
      return (
        <>
          <TimeLine at={step.ts} previous={previous} />
          <div className="um">
            {(step.images.length > 0 || step.files.length > 0) && (
              <div className="um-att">
                {step.images.map((im, i) => (
                  <Tile key={i} kind="image" src={`data:${im.mime_type};base64,${im.data}`} />
                ))}
                {step.files.map((f) => (
                  <Tile key={f} kind={/[\\/]$/.test(f) ? "folder" : "file"} path={f} name={baseName(f)} />
                ))}
              </div>
            )}
            {step.text !== "" && (
              <div className="bub sel-text">
                <Words text={step.text} skills={step.skills} />
              </div>
            )}
            <Copy text={step.text} at={step.ts} />
          </div>
        </>
      );
    case "text":
      return (
        <div className="am">
          {step.live ? <DraftMarkdown text={step.text} /> : <Markdown text={step.text} />}
          {!step.live && <Copy text={step.text} at={step.ts} />}
        </div>
      );
    case "work":
      return <Work items={step.items} live={step.live} />;
    case "agents":
      return <AgentCard launches={step.launches} />;
    case "report":
      return <ReportCard step={step} />;
    case "end":
      return <TaskEnd end={step.end} chain={step.chain} started={previous} current={current} sessionId={sessionId} />;
    case "note":
      return step.note.note === "compaction" ? (
        <div className="tnote">{t("chat.compacted", { before: kilo(step.note.tokens_before), after: kilo(step.note.tokens_after) })}</div>
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

/** Under a message on hover: how long ago it was written (the full time on hover), and Copy. */
function Copy({ text, at }: { text: string; at?: number }) {
  const { t } = useTranslation("session");
  const [done, setDone] = useState(false);
  return (
    <div className="msg-act">
      {at !== undefined && <MessageTime at={new Date(at)} />}
      <button
        className="tb"
        aria-label={t("chat.copy")}
        title={t("chat.copy")}
        onClick={() => navigator.clipboard.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}
      >
        <Icon name={done ? "check" : "copy"} className="sm" />
      </button>
    </div>
  );
}

function MessageTime({ at }: { at: Date }) {
  const now = useNow(agoInterval(at));
  return (
    <time className="msg-time" dateTime={at.toISOString()} title={at.toLocaleString()}>
      {messageAgo(at, now)}
    </time>
  );
}

/**
 * Where a task ended: a quiet line when it went well, a word when it stopped early, the failure in red.
 * A piece of work that took several tasks or sub-agents is told once, at its end, as a whole.
 */
function TaskEnd({ end, chain, started, current, sessionId }: { end: TaskEndItem; chain?: TaskChain; started: number | undefined; current: boolean; sessionId: string }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const modelProvider = st.sessions.find((s) => s.session_id === sessionId)?.model?.split("/")[0];
  const [open, setOpen] = useState(false);
  if (end.outcome === "interrupted") return <div className="tnote">{t("chat.interrupted")}</div>;
  if (end.outcome === "completed") {
    if (end.reason && end.reason !== "done") return <div className="tnote">{t(`chat.ended.${end.reason}`)}</div>;
    const from = chain?.started ?? started;
    const u = totals((chain ? chain.usage : end.usage) ?? { per_model: {} });
    const parts = [
      from !== undefined && end.ts > from ? durationText(end.ts - from) : "",
      chain && chain.agents > 0 ? t("chat.agents", { count: chain.agents }) : "",
      u.tokens > 0 ? t("chat.tokens", { tokens: kilo(u.tokens) }) : "",
      ...u.costs.filter((c) => c.total > 0).map(costText),
    ].filter(Boolean);
    return (
      <div className="donebar">
        <Icon name="check" className="sm" />
        <span>{[t("chat.done"), ...parts].join(" · ")}</span>
      </div>
    );
  }
  const e = end.error;
  const kind = e?.kind ?? "unknown";
  if (!current) {
    return (
      <div className="qfail past">
        <button className="qf-line" aria-expanded={e?.message ? open : undefined} onClick={() => e?.message && setOpen(!open)}>
          <Icon name="info" className="sm" />
          <span>{t("chat.failedWith", { title: failureTitle(kind) })}</span>
          {e?.message && <Icon name="chevR" className={`sm chev ${open ? "open" : ""}`} />}
        </button>
        {open && <div className="qf-raw sel-text">{e?.message}</div>}
      </div>
    );
  }
  return (
    <div className="qfail" role="alert">
      <div className="qf-line">
        <Icon name="info" className="sm" />
        <b>{t("chat.failedWith", { title: failureTitle(kind) })}</b>
      </div>
      <div className="qf-hint">{failureAdvice(kind, e?.retryable ?? false)}</div>
      <div className="qf-act">
        {/* No key for the model's provider: set one, then retry. */}
        {kind === "auth" && (
          <button className="link go" onClick={() => window.dispatchEvent(new CustomEvent(keyEvent, { detail: modelProvider }))}>
            <Icon name="key" className="sm" />
            {t("chat.setKey")}
          </button>
        )}
        <button className="link go" onClick={() => st.op(sessionId, { type: "continue" })}>
          <Icon name="retry" className="sm" />
          {t("chat.retry")}
        </button>
        {e?.message && (
          <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
            {t("chat.details")} <Icon name="chevR" className={`sm chev ${open ? "open" : ""}`} />
          </button>
        )}
      </div>
      {open && <div className="qf-raw sel-text">{e?.message}</div>}
    </div>
  );
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
