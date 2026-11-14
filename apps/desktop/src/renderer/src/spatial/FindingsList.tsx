import { useTranslation } from "react-i18next";
import type { FindingSource, SpatialFinding } from "@finx/protocol";

const GROUP_ORDER: FindingSource[] = ["reference", "ai", "user"];

export type FindingsListProps = {
  findings: readonly SpatialFinding[];
  focusedId: string | null;
  hasVolume: boolean;
  onLocate: (f: SpatialFinding) => void;
  onViewSlice: (f: SpatialFinding) => void;
  onAsk: (f: SpatialFinding) => void;
};

export function FindingsList({ findings, focusedId, hasVolume, onLocate, onViewSlice, onAsk }: FindingsListProps) {
  const { t } = useTranslation("session");
  if (!findings.length) return null;

  const grouped = GROUP_ORDER.map((source) => ({
    source,
    items: findings.filter((f) => f.source === source),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="spf" aria-label={t("spatial.findings")}>
      {grouped.map(({ source, items }) => (
        <section key={source} className={`spf-group spf-group--${source}`}>
          <header className="spf-group-head">
            <span className={`spf-badge spf-badge--${source}`}>{t(`spatial.source.${source}`)}</span>
            <span className="spf-count">{items.length}</span>
          </header>
          <div className="spf-cards">
            {items.map((f) => {
              const active = focusedId === f.id;
              const canLocate = !!(f.position_mm?.length === 3 || f.view?.camera);
              const canSlice = hasVolume && !!(f.position_mm?.length === 3 || f.view?.slice);
              return (
                <article key={f.id} className={`spf-card spf-card--${source} ${active ? "on" : ""}`}>
                  <div className="spf-card-title">
                    <strong title={f.name}>{f.name}</strong>
                    {f.report_item && <span className="spf-report">{f.report_item}</span>}
                  </div>
                  {f.summary && <p className="spf-summary">{f.summary}</p>}
                  {f.measures && f.measures.length > 0 && (
                    <div className="spf-measures">
                      {f.measures.map((m, i) => (
                        <span key={i} className="spf-measure">
                          {m.name}: {Number.isInteger(m.value) ? m.value : m.value.toFixed(1)}
                          {m.unit ? ` ${m.unit}` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  {f.evidence && f.evidence.length > 0 && (
                    <ul className="spf-evidence">
                      {f.evidence.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                  <div className="spf-actions">
                    {canLocate && (
                      <button className={`btn sm ${active ? "on" : ""}`} onClick={() => onLocate(f)}>
                        {t("spatial.locate")}
                      </button>
                    )}
                    {canSlice && (
                      <button className="btn sm" onClick={() => onViewSlice(f)}>
                        {t("spatial.viewSlice")}
                      </button>
                    )}
                    <button className="btn sm" onClick={() => onAsk(f)}>
                      {t("spatial.ask")}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
