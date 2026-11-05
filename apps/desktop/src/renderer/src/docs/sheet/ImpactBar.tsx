import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Impact } from "@finx/protocol";
import { Icon } from "../../icons";
import { splitRef } from "../cellref";

/** What the last edit moved: its key outputs, how many cells, what Excel recalculates. */
export function ImpactBar({ impact, onClose, onJump }: { impact: Impact; onClose: () => void; onJump: (sheet: string, cell: string) => void }) {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const pct = (a?: unknown, b?: unknown) => {
    const x = (a as { value?: unknown } | undefined)?.value;
    const y = (b as { value?: unknown } | undefined)?.value;
    return typeof x === "number" && typeof y === "number" && x !== 0 ? ` (${((y - x) / Math.abs(x)) * 100 >= 0 ? "+" : ""}${(((y - x) / Math.abs(x)) * 100).toFixed(1)}%)` : "";
  };
  return (
    <div className={`sht-impact ${open ? "open" : ""}`} role="status">
      <div className="sht-impact-summary">
        <button className="sht-impact-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}><Icon name={open ? "chevD" : "chevR"} /><b>{t("sheet.impact")}</b></button>
        <span>{t("sheet.edited", { count: impact.edited.length })}</span>
        <span>{t("sheet.affected", { count: impact.affected_count })}</span>
        {(impact.needs_excel?.length ?? 0) > 0 && <span>{t("sheet.needsExcel", { count: impact.needs_excel!.length })}</span>}
        {impact.iterations != null && <span>{t("sheet.iterated", { count: impact.iterations })}</span>}
        {!impact.converged && <span className="bad">{t("sheet.notConverged")}</span>}
        <button className="tb" aria-label={t("sheet.dismiss")} onClick={onClose}><Icon name="x" /></button>
      </div>
      {open && (
        <div className="sht-impact-body">
          <ImpactTable title={t("sheet.changes")} rows={impact.edited} onJump={onJump} pct={() => ""} />
          {(impact.key_outputs?.length ?? 0) > 0 && <ImpactTable title={t("sheet.outputs")} rows={impact.key_outputs!} onJump={onJump} pct={pct} />}
          {(impact.needs_excel?.length ?? 0) > 0 && <div className="sht-impact-table">
            <b>{t("sheet.needsExcel", { count: impact.needs_excel!.length })}</b>
            {impact.needs_excel!.slice(0, 20).map((name) => {
              const ref = splitRef(name);
              return <button key={name} onClick={() => ref && onJump(ref.sheet, ref.cell)}><code>{name}</code></button>;
            })}
          </div>}
          {impact.calc_unavailable && <p>{t("sheet.calcUnavailable", { reason: impact.calc_unavailable })}</p>}
        </div>
      )}
    </div>
  );
}

function ImpactTable({ title, rows, onJump, pct }: { title: string; rows: Impact["edited"]; onJump: (sheet: string, cell: string) => void; pct: (a?: unknown, b?: unknown) => string }) {
  return (
    <div className="sht-impact-table">
      <b>{title}</b>
      {rows.slice(0, 5).map((row) => (
        <button key={`${row.sheet}!${row.cell}`} onClick={() => onJump(row.sheet, row.cell)}>
          <code>{row.sheet}!{row.cell}</code>
          <span>{row.label ?? ""}</span>
          <span>{row.before_text || "—"} → {row.after_text || "—"}{pct(row.before, row.after)}</span>
        </button>
      ))}
      {rows.length > 5 && <small>+{rows.length - 5}</small>}
    </div>
  );
}
