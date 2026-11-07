import { useTranslation } from "react-i18next";
import "../pptx/theme.css";
import "../pptx/loading.css";

type Stage = "reading" | "fonts" | "rendering";

/** Opening a Word document: the presentation's loading card (pptx/loading.css), in Word's words. */
export function WordLoading({ name, stage, completed = 0, total = 0 }: { name: string; stage: Stage; completed?: number; total?: number }) {
  const { t } = useTranslation("session");
  const percent = stage === "fonts" && total > 0 ? Math.min(100, Math.floor(completed / total * 100)) : null;
  const label = t(`word.progress.${stage}`);
  return <div className="pptx-load" aria-busy="true" data-stage={stage}>
    <section className="pptx-load-card" aria-label={t("word.loadingTitle")}>
      <div className="pptx-load-status" role="status" aria-live="polite">
        <h3>{label}</h3>
        {percent !== null && <span className="pptx-load-percent">{percent}%</span>}
      </div>
      <div className={`pptx-load-track ${percent !== null ? "" : "indeterminate"}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
        <span style={percent !== null ? { width: `${percent}%` } : undefined} />
      </div>
      <p className="pptx-load-file"><span title={name}>{name}</span></p>
    </section>
  </div>;
}
