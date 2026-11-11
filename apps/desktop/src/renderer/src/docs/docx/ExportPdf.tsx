import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WordDoc } from "./document";
import type { WordPdfResult } from "./kernel";

/** `report.docx` → `report.pdf`, beside it. */
export function pdfPathOf(path: string): string {
  return /\.docx$/i.test(path) ? path.replace(/\.docx$/i, ".pdf") : `${path}.pdf`;
}

type Stage = { kind: "form" } | { kind: "exporting" } | { kind: "done"; result: WordPdfResult } | { kind: "failed"; message: string };

/**
 * Export as PDF (word-design §6): the document as it is now, unsaved edits included, drawn by the
 * kernel as the pages show. Which pages, and whether tracked changes show, as Word's "Save as
 * PDF" asks; the .docx itself is left as it is.
 */
export function ExportPdfDialog({ doc, path, onClose }: { doc: WordDoc; path: string; onClose: () => void }) {
  const { t } = useTranslation("session");
  const [range, setRange] = useState<"all" | "pages">("all");
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState("1");
  const [markup, setMarkup] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>("input, select, button")?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && stage.kind !== "exporting") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, stage.kind]);

  const first = Number.parseInt(from, 10), last = Number.parseInt(to, 10);
  const badRange = range === "pages" && !(first >= 1 && last >= first);

  const run = async () => {
    if (badRange) return;
    const suggested = pdfPathOf(path);
    const target = window.finx ? await window.finx.pickSaveFile(suggested) : window.prompt(t("word.pdf.title"), suggested);
    if (!target) return;
    setStage({ kind: "exporting" });
    try {
      const result = await doc.exportPdf({
        path: target,
        ...(range === "pages" ? { from_page: first, to_page: last } : {}),
        ...(markup ? { markup: true } : {}),
      });
      setStage({ kind: "done", result });
    } catch (e) {
      setStage({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return <div className="word-dialog-layer" onMouseDown={(e) => { if (e.target === e.currentTarget && stage.kind !== "exporting") onClose(); }}>
    <div className="word-dialog" role="dialog" aria-modal="true" aria-label={t("word.pdf.title")} ref={box}>
      <h3>{t("word.pdf.title")}</h3>
      {stage.kind === "done" ? <>
        <p>{stage.result.pages === stage.result.total_pages
          ? t("word.pdf.doneAll", { count: stage.result.pages })
          : t("word.pdf.donePages", { count: stage.result.pages, total: stage.result.total_pages })}</p>
        <p className="word-dialog-path" title={stage.result.path}>{stage.result.path}</p>
        {stage.result.outlined_fonts.length > 0 && <p className="word-dialog-note">{t("word.pdf.outlined", { fonts: stage.result.outlined_fonts.join("、") })}</p>}
        <div className="word-dialog-actions">
          <button type="button" className="btn sm" onClick={() => window.finx?.revealPath(stage.result.path)}>{t("word.pdf.reveal")}</button>
          <button type="button" className="btn sm" onClick={() => { void window.finx?.openFile(stage.result.path); onClose(); }}>{t("word.pdf.open")}</button>
          <button type="button" className="btn sm primary" onClick={onClose}>{t("word.pdf.close")}</button>
        </div>
      </> : <>
        <fieldset disabled={stage.kind === "exporting"}>
          <legend>{t("word.pdf.pages")}</legend>
          <label><input type="radio" name="word-pdf-range" checked={range === "all"} onChange={() => setRange("all")} /> {t("word.pdf.allPages")}</label>
          <label className="word-dialog-range">
            <input type="radio" name="word-pdf-range" checked={range === "pages"} onChange={() => setRange("pages")} /> {t("word.pdf.fromPage")}
            <input type="number" min={1} value={from} aria-label={t("word.pdf.fromLabel")} onChange={(e) => { setFrom(e.target.value); setRange("pages"); }} />
            {t("word.pdf.toPage")}
            <input type="number" min={1} value={to} aria-label={t("word.pdf.toLabel")} onChange={(e) => { setTo(e.target.value); setRange("pages"); }} />
          </label>
          {badRange && <p className="word-dialog-error">{t("word.pdf.badRange")}</p>}
        </fieldset>
        <fieldset disabled={stage.kind === "exporting"}>
          <legend>{t("word.pdf.content")}</legend>
          <select value={markup ? "markup" : "final"} onChange={(e) => setMarkup(e.target.value === "markup")}>
            <option value="final">{t("word.pdf.final")}</option>
            <option value="markup">{t("word.pdf.markup")}</option>
          </select>
        </fieldset>
        {stage.kind === "failed" && <p className="word-dialog-error" role="alert">{t("word.pdf.failed", { message: stage.message })}</p>}
        <div className="word-dialog-actions">
          <button type="button" className="btn sm" disabled={stage.kind === "exporting"} onClick={onClose}>{t("word.pdf.cancel")}</button>
          <button type="button" className="btn sm primary" disabled={stage.kind === "exporting" || badRange} onClick={() => void run()}>
            {stage.kind === "exporting" ? t("word.pdf.exporting") : t("word.pdf.export")}
          </button>
        </div>
      </>}
    </div>
  </div>;
}
