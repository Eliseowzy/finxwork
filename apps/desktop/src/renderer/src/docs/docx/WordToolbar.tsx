import { useEffect, useSyncExternalStore } from "react";
import { useTranslation as useAppTranslation } from "react-i18next";
import { EditorToolbar, ToolbarButton, ToolbarCommand, ToolbarGroup, ToolbarSeparator, useDocxCommandState, useTranslation } from "@betteroffice/docx-react";
import { resolveHighlightColor } from "@betteroffice/docx/utils";

/** The pen's colour (a Word highlight name or RGB hex) as CSS. */
function penSwatch(color: string): string {
  const hex = resolveHighlightColor(color);
  return hex ? (hex.startsWith("#") ? hex : `#${hex}`) : "#f5d000";
}

/**
 * Fit-to-width zoom: on until the person picks a zoom of their own. `set` is the last zoom this set,
 * so a different zoom in the editor means the person chose it.
 */
export interface WordFit { auto: boolean; set: number | null; refit: () => void; zoomed: (zoom: number) => void; sidebar: boolean; pen: boolean; penColor: string; listeners: Set<() => void>; exportPdf: () => void }

export function createFit(): WordFit {
  return { auto: true, set: null, refit: () => {}, zoomed: () => {}, sidebar: false, pen: false, penColor: "yellow", listeners: new Set(), exportPdf: () => {} };
}

/**
 * The editor's chrome in the file panel: one compact row, no title bar (the panel's tab names the
 * file). The most used controls come first, as the row overflows into "More" from its end.
 */
export function WordToolbar({ fit }: { fit: WordFit }) {
  const { t } = useTranslation();
  const { t: app } = useAppTranslation("session");
  const zoom = useDocxCommandState("zoom").value;
  const sidebar = !!useDocxCommandState("commentsSidebar").active;
  useEffect(() => { fit.sidebar = sidebar; fit.refit(); }, [sidebar, fit]);
  const table = useDocxCommandState("tableAction").value != null;
  const wrap = useDocxCommandState("imageWrap").value != null;
  const image = useDocxCommandState("imageProperties").enabled || wrap;
  const auto = useSyncExternalStore((l) => { fit.listeners.add(l); return () => fit.listeners.delete(l); }, () => fit.auto);
  const pen = useSyncExternalStore((l) => { fit.listeners.add(l); return () => fit.listeners.delete(l); }, () => fit.pen);
  const penColor = useSyncExternalStore((l) => { fit.listeners.add(l); return () => fit.listeners.delete(l); }, () => fit.penColor);
  // A zoom this did not set is the person's: stop fitting.
  useEffect(() => {
    if (typeof zoom === "number") fit.zoomed(zoom);
    if (typeof zoom === "number" && fit.set !== null && Math.abs(zoom - fit.set) > 0.001 && fit.auto) {
      fit.auto = false;
      fit.listeners.forEach((l) => l());
    }
  }, [zoom, fit]);
  return <EditorToolbar className="word-toolbar">
    <EditorToolbar.Toolbar>
      <ToolbarGroup label={t("formattingBar.groups.history")}>
        <ToolbarCommand id="undo" />
        <ToolbarCommand id="redo" />
      </ToolbarGroup>
      <ToolbarButton title={app("word.pdf.button")} onClick={() => fit.exportPdf()}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><text x="8.5" y="12.2" textAnchor="middle" fontSize="4.6" fontWeight="700" fill="currentColor">PDF</text></svg>
      </ToolbarButton>
      <ToolbarGroup label={t("formattingBar.groups.styles")}>
        <ToolbarCommand id="paragraphStyle" />
      </ToolbarGroup>
      <ToolbarGroup label={t("formattingBar.groups.textFormatting")}>
        <ToolbarCommand id="bold" />
        <ToolbarCommand id="italic" />
        <ToolbarCommand id="underline" />
        <ToolbarCommand id="textColor" />
        <ToolbarCommand id="highlightColor" />
        <ToolbarButton
          active={pen}
          title={app("word.highlighterPen")}
          onClick={() => { fit.pen = !fit.pen; fit.listeners.forEach((l) => l()); }}
        ><svg className="word-pen-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5l4 4-6 6H4.5l-1-1v-3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><rect x="2" y="13.5" width="12" height="1.5" rx=".5" fill={penSwatch(penColor)} /></svg></ToolbarButton>
      </ToolbarGroup>
      <ToolbarGroup label={t("formattingBar.groups.alignment")}>
        <ToolbarCommand id="alignment" />
      </ToolbarGroup>
      <ToolbarGroup label={t("formattingBar.groups.listFormatting")}>
        <ToolbarCommand id="bulletList" />
        <ToolbarCommand id="numberedList" />
      </ToolbarGroup>
      {image && <ToolbarGroup label={t("formattingBar.groups.image")}>
        <ToolbarCommand id="imageWrap" />
        <ToolbarCommand id="imageTransform" />
        <ToolbarCommand id="imageProperties" />
      </ToolbarGroup>}
      {table && <ToolbarGroup label={t("formattingBar.groups.table")}>
        <ToolbarCommand id="tableAction" />
      </ToolbarGroup>}
      <ToolbarGroup label={t("formattingBar.groups.zoom")}>
        <ToolbarButton
          active={auto}
          title={app("word.fitWidth")}
          onClick={() => { fit.auto = true; fit.refit(); fit.listeners.forEach((l) => l()); }}
        ><span className="word-fit-icon" aria-hidden="true">↔</span></ToolbarButton>
        <ToolbarCommand id="zoom" />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarCommand id="commentsSidebar" />
      <ToolbarCommand id="editingMode" />
      <ToolbarGroup label={t("formattingBar.groups.font")}>
        <ToolbarCommand id="fontFamily" />
        <ToolbarCommand id="fontSize" />
      </ToolbarGroup>
      <ToolbarGroup label={t("formattingBar.groups.textFormatting")}>
        <ToolbarCommand id="strikethrough" />
        <ToolbarCommand id="superscript" />
        <ToolbarCommand id="subscript" />
        <ToolbarCommand id="insertLink" />
      </ToolbarGroup>
      <ToolbarGroup label={t("formattingBar.groups.listFormatting")}>
        <ToolbarCommand id="outdent" />
        <ToolbarCommand id="indent" />
        <ToolbarCommand id="lineSpacing" />
      </ToolbarGroup>
      <ToolbarCommand id="clearFormatting" />
    </EditorToolbar.Toolbar>
  </EditorToolbar>;
}
