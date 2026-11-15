import { useEffect, useState } from "react";
import type { PptxAsyncEditorApi } from "@nimbleoffice/pptx-react";
import type { SlideSnapshot } from "@nimbleoffice/pptx";
import { outlineLines } from "./outlineModel";
import { useTranslation } from "react-i18next";

/** Read-only overview. Editing continues on the slide after navigation. */
export function SlideOutline({ api, revision }: { api: PptxAsyncEditorApi; revision: number }) {
  const { t } = useTranslation("session");
  const [slides, setSlides] = useState<SlideSnapshot[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => void api.readContent().then(result => {
      if (!live) return;
      if (result.ok) { setSlides(result.slides); setError(false); }
      else setError(true);
    }).catch(() => { if (live) setError(true); }), 250);
    return () => { live = false; clearTimeout(timer); };
  }, [api, revision]);
  const navigate = async (id: string) => {
    try {
      const result = await api.readContent();
      if (!result.ok) { setError(true); return; }
      const index = result.slides.findIndex(slide => slide.id === id);
      if (index >= 0) await api.goToSlide(index + 1);
    } catch { setError(true); }
  };
  return <aside className="pptx-outline" aria-label={t("pptx.outlineTitle")}>
    {error && <div role="alert">{t("pptx.outlineError")}</div>}
    {slides.map((slide, index) => {
      const lines = outlineLines(slide);
      return <button className="pptx-outline-slide" type="button" key={slide.id} onClick={() => void navigate(slide.id)}>
        <strong>{index + 1}. {slide.title || lines[0] || t("pptx.outlineUntitled")}</strong>
        {lines.slice(slide.title && lines[0] !== slide.title ? 0 : 1, 5).map((line, i) => <span key={i}>{line}</span>)}
      </button>;
    })}
  </aside>;
}
