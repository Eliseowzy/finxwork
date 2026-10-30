import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { tokensText, type SessionView } from "@finx/client";
import type { ContextPartKind, ContextReport } from "@finx/protocol";
import { Icon } from "../icons";
import { useStore } from "../store";

/**
 * The context card, under the environment's: what fills the window of the
 * session's model, as finx reports it (`session/context`). Closed, the share
 * used and a small bar; open, the share and the size, a bar of the parts,
 * and a line per part, then the room kept and the room free.
 */
export function ContextCard({ id, view }: { id: string; view: SessionView }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const report = useContextReport(id, view);
  if (!report) return null;
  const window = report.usage.window;
  const share = (tokens: number) => (window ? (tokens / window) * 100 : 0);
  const used = share(report.usage.tokens);
  const rows: { key: Kind; tokens: number }[] = [
    ...report.parts.map((p) => ({ key: kindOf(p.kind), tokens: p.tokens })),
    { key: "reserved", tokens: report.reserved },
    { key: "free", tokens: report.free },
  ];
  const open = st.contextOpen;
  return (
    <section className="insp">
      <button className="insp-h" aria-expanded={open} onClick={() => st.set({ contextOpen: !open })}>
        <h3>{t("inspector.context")}</h3>
        <Icon name="caret" className={open ? "" : "shut"} />
        {!open && (
          <span className="insp-glance">
            {Math.round(used)}%
            <span className="ctx-mini">
              <i style={{ width: `${Math.min(100, used)}%` }} />
            </span>
          </span>
        )}
      </button>
      {open && (
        <div className="ctx-body">
          <div className="ctx-sum" title={report.usage.estimated > 0 ? t("inspector.estimated", { tokens: tokensText(report.usage.estimated) }) : undefined}>
            <span>{t("inspector.used", { percent: Math.round(used) })}</span>
            <span className="ctx-of">
              {tokensText(report.usage.tokens)} / {tokensText(window)}
            </span>
          </div>
          {/* The window from left to right: its parts, the free room, then the room kept at the end. */}
          <div className="ctx-bar" role="img" aria-label={t("inspector.used", { percent: Math.round(used) })}>
            {rows.map((r) => r.key !== "free" && r.tokens > 0 && <i key={r.key} className={`ctx-${r.key}`} style={{ width: `${share(r.tokens)}%` }} />)}
          </div>
          <ul className="ctx-rows">
            {rows.map((r) => (
              <li key={r.key} title={t(`inspector.parts.${r.key}.desc`)}>
                <i className={`ctx-sw ctx-${r.key}`} />
                <span className="ctx-name">{t(`inspector.parts.${r.key}.name`)}</span>
                <span className="ctx-n">{tokensText(r.tokens)}</span>
                <span className="ctx-p">{share(r.tokens).toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** A row of the section: a part of the context (one finx adds later shows as `other`), the kept room, or the free room. */
type Kind = ContextPartKind | "other" | "reserved" | "free";

const known: ContextPartKind[] = ["messages", "system_prompt", "tools", "skills", "mcp"];
const kindOf = (kind: string): Kind => (known.includes(kind as ContextPartKind) ? (kind as ContextPartKind) : "other");

/**
 * The session's context report, asked for again as the session changes: a
 * message or tool result added, a model or thinking level chosen, a turn
 * begun. finx keeps the report until the session changes, so asking is cheap;
 * asks a burst of changes makes go out as one. An answer to `/context` is
 * taken as it comes. Null until the first answer, and when finx cannot give one.
 */
function useContextReport(id: string, view: SessionView): ContextReport | null {
  const st = useStore();
  const [report, setReport] = useState<ContextReport | null>(null);
  const changed = `${view.entries.length}|${view.info.model}|${view.info.thinking}|${view.live?.turn ?? ""}|${view.context}`;
  const call = st.call;
  const first = useRef(true);
  useEffect(() => {
    let current = true;
    const delay = first.current ? 0 : 200;
    first.current = false;
    const timer = setTimeout(() => {
      call("session/context", { session_id: id }).then(
        (r) => current && setReport(r),
        () => {},
      );
    }, delay);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [id, changed, call]);
  const asked = view.asked?.report;
  useEffect(() => {
    if (asked) setReport(asked);
  }, [asked]);
  return report;
}
