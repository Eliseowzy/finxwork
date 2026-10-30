import { Trans, useTranslation } from "react-i18next";
import { baseName, clockText, costText, elapsedSeconds, homePath, runningAgents, statusOf, tokensText, totals, type ListSession, type SessionView } from "@finx/client";
import { StatusDot } from "../components";
import { permissionTitle, failureTitle, modelTitle, stateTitle, thinkingTitle } from "../format";
import { Icon } from "../icons";
import { useNow, useStore } from "../store";

/**
 * A card floating over the conversation's top right: what a glance should
 * give. While a task runs, waits or has failed, first its state (what and
 * for how long, or why it stopped); then with which model, under which
 * approval mode and where the session works; then what it has cost and how
 * full its context is, in one line. Shown or hidden with the toolbar's
 * button (⌥⌘0).
 */
export function Inspector({ s, view }: { s: ListSession; view: SessionView }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const now = useNow(1000);
  const status = statusOf(view);
  const info = view.info;
  const project = baseName(info.cwd);
  const sum = totals(view.usage);
  const tasks = view.entries.filter((e) => e.type === "task_end").length + (view.live ? 1 : 0);
  const part = info.context_window ? Math.min(1, view.context / info.context_window) : 0;
  const tone = status === "awaiting_approval" ? "w" : status === "failed" ? "r" : "";
  // Nothing runs in the session itself, but its sub-agents work: since when, how many, and the way to them.
  const agents = runningAgents(view);
  const background = status === "idle" && agents.length > 0 && (
    <div className="insp-state">
      <div className="insp-now">
        <span className="insp-st">
          <StatusDot state="running" />
          {t("inspector.background")}
        </span>
        <span className="insp-time">{clockText(elapsedSeconds(Math.min(...agents.map((a) => a.since)), now.getTime()))}</span>
      </div>
      <div className="insp-why">
        {t("inspector.agents", { count: agents.length })}
        {" · "}
        <button className="link" onClick={() => st.set({ background: true })}>{t("inspector.viewBackground")}</button>
      </div>
    </div>
  );
  return (
    <aside className="insp" aria-label={t("inspector.label")}>
      {background}
      {status !== "idle" && (
        <div className="insp-state">
          <div className="insp-now">
            <span className={`insp-st ${tone}`}>
              <StatusDot state={status} />
              {stateTitle(status)}
            </span>
            {view.live && <span className="insp-time">{clockText(elapsedSeconds(view.live.started, now.getTime()))}</span>}
          </div>
          <div className={`insp-why ${tone}`}>
            {view.live ? t("inspector.turn", { turn: Math.max(1, view.live.turn) }) : failureTitle(view.failure?.kind ?? "unknown")}
          </div>
        </div>
      )}

      {/* As the baseline's card: with what, how, and where, each a line; the name that matters in bold. */}
      <ul className="insp-facts">
        <li>
          <Icon name="sparkle" />
          <span>
            <b>{modelTitle(info.model, st.models)}</b>
            {info.thinking !== "default" && ` · ${t("inspector.thinking", { level: thinkingTitle(info.thinking) })}`}
          </span>
        </li>
        <li>
          <Icon name="shield" />
          <span>{permissionTitle(info.permission_mode)}</span>
        </li>
        {/* A long path gives way before the project's name does. */}
        <li title={info.cwd}>
          <Icon name="folder" />
          <span className="insp-where">
            <span>{homePath(parentDir(info.cwd), window.finx?.home ?? "")}</span>
            <i> / </i>
            <b>{project}</b>
          </span>
        </li>
      </ul>

      <div className="insp-sum">
        <span><Trans t={t} i18nKey="inspector.tasks" count={tasks} components={{ b: <b /> }} /></span>
        {sum.tokens > 0 && <span><b>{tokensText(sum.tokens)}</b> tokens</span>}
        {sum.costs.filter((c) => c.total > 0).map((c) => <span key={c.currency}><b>{costText(c)}</b></span>)}
        {info.context_window > 0 && (
          <span className={part > 0.8 ? "warn" : ""} title={t("inspector.contextOf", { used: tokensText(view.context), size: tokensText(info.context_window) })}>
            <Trans t={t} i18nKey="inspector.context" values={{ percent: Math.round(part * 100) }} components={{ b: <b /> }} />
          </span>
        )}
      </div>
    </aside>
  );
}

/** The folder a project sits in: "/Users/me/CodeSpace/finxwork" → "/Users/me/CodeSpace". */
function parentDir(path: string): string {
  const i = path.replace(/[\\/]+$/, "").search(/[\\/][^\\/]*$/);
  return i > 0 ? path.slice(0, i) : path;
}
