import { useTranslation } from "react-i18next";
import { sizeText } from "../../format";
import type { PresentationProgress } from "./progress";
import "./loading.css";

export type FontLoadProgress = { completed: number; total: number; family?: string; bold?: boolean; italic?: boolean };
type Stage = PresentationProgress["stage"] | "preparing" | "fonts" | "rendering";

/** Only stage-local counts are measurable; rendering deliberately stays indeterminate. */
export function PresentationLoading({ name, stage, completed = 0, total = 0 }: {
  name: string; stage: Stage; completed?: number; total?: number; bytes?: number; fontCount?: number; font?: FontLoadProgress;
}) {
  const { t } = useTranslation("session");
  const measured = total > 0 && ["reading", "inspecting", "fonts"].includes(stage);
  const percent = measured ? Math.min(100, Math.floor(completed / total * 100)) : null;
  const count = measured && stage === "reading" ? `${sizeText(completed)} / ${sizeText(total)}` : null;
  const label = t(`pptx.progress.${stage}`);
  return <div className="pptx-load" aria-busy="true" data-stage={stage}>
    <section className="pptx-load-card" aria-label={t("pptx.loadingPanel.title")}>
      <div className="pptx-load-status" role="status" aria-live="polite">
        <h3>{label}</h3>
        {percent !== null && <span className="pptx-load-percent">{percent}%</span>}
      </div>
      <div className={`pptx-load-track ${measured ? "" : "indeterminate"}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
        <span style={measured ? { width: `${percent}%` } : undefined} />
      </div>
      <p className="pptx-load-hint">{t(`pptx.loadingPanel.hints.${stage}`)}</p>
      <p className="pptx-load-file"><span title={name}>{name}</span>{count && <span>{count}</span>}</p>
    </section>
  </div>;
}
