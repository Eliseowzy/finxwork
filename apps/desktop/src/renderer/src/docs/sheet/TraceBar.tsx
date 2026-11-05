import { useTranslation } from "react-i18next";
import type { FoundCell } from "@finx/protocol";
import { Icon } from "../../icons";

/** A trace in progress: from which cell, which way, how many steps out, and what it found. */
export type Trace = { sheet: string; cell: string; direction: "up" | "down"; depth: number; cells: FoundCell[]; more: boolean };

/**
 * The cells a trace reached (spreadsheet-design §8.7), under the toolbar: the arrows on the grid
 * show the ones on this sheet; the list has them all, other sheets' too, each a click away.
 */
export function TraceBar({ trace, onJump, onMore, onClose }: { trace: Trace; onJump: (sheet: string, cell: string) => void; onMore: () => void; onClose: () => void }) {
  const { t } = useTranslation("session");
  const origin = `${trace.sheet}!${trace.cell}`;
  const title = t(trace.direction === "up" ? "sheet.traceUpTitle" : "sheet.traceDownTitle", { cell: origin, count: trace.cells.length, depth: trace.depth });
  return (
    <div className="sht-trace" role="region" aria-label={title}>
      <div className="sht-trace-head">
        <Icon name={trace.direction === "up" ? "tracePre" : "traceDep"} />
        <b>{title}{trace.more ? "+" : ""}</b>
        <span className="sht-trace-end">
          {trace.depth < 10 && trace.cells.length > 0 && <button className="btn sm" onClick={onMore}>{t("sheet.traceMore")}</button>}
          <button className="tb" aria-label={t("sheet.traceClear")} title={t("sheet.traceClear")} onClick={onClose}><Icon name="x" /></button>
        </span>
      </div>
      {trace.cells.length === 0 ? (
        <div className="sht-trace-empty">{t(trace.direction === "up" ? "sheet.traceNoneUp" : "sheet.traceNoneDown")}</div>
      ) : (
        <div className="sht-trace-list">
          {trace.cells.map((c) => (
            <button key={`${c.sheet}!${c.cell}`} className="sht-trace-row" style={{ paddingLeft: 8 + (c.depth - 1) * 14 }} onClick={() => onJump(c.sheet, c.cell)}>
              <span className="sht-trace-at">{c.sheet === trace.sheet ? c.cell : `${c.sheet}!${c.cell}`}</span>
              {c.label && <span className="sht-trace-label">{c.label}</span>}
              <span className="sht-trace-v">{c.text}</span>
              {c.formula && <code>{c.formula}</code>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
