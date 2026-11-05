import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "../../components";
import { DraftContext } from "../scope";

const tsvCell = (value: string) => /[\t\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
export function MarkdownTable({ children, source }: { children: ReactNode; source: string }) {
  const { t } = useTranslation("session");
  const draft = useContext(DraftContext);
  const scroll = useRef<HTMLDivElement>(null);
  const widths = useRef<number[]>([]);
  const [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (wasExpanded.current && !expanded) expandButton.current?.focus();
    wasExpanded.current = expanded;
  }, [expanded]);
  const [overflow, setOverflow] = useState(false);
  const [status, setStatus] = useState("");
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const head = [...el.querySelectorAll<HTMLTableCellElement>("th")];
    if (draft) {
      if (widths.current.length !== head.length) widths.current = head.map((cell) => Math.ceil(cell.getBoundingClientRect().width));
      head.forEach((cell, i) => { cell.style.minWidth = `${widths.current[i]}px`; });
    } else head.forEach((cell) => { cell.style.minWidth = ""; });
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [children, draft, expanded]);
  const copy = async (format: "markdown" | "tsv" | "html") => {
    const table = scroll.current?.querySelector("table");
    if (!table) return;
    const tsv = [...table.rows].map((row) => [...row.cells].map((cell) => tsvCell(cell.innerText)).join("\t")).join("\n");
    try {
      if (format === "html" && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([tsv], { type: "text/plain" }), "text/html": new Blob([table.outerHTML], { type: "text/html" }) })]);
      } else await navigator.clipboard.writeText(format === "markdown" ? source : tsv);
      setStatus(t("markdown.copied"));
    } catch { setStatus(t("markdown.copyFailed")); }
  };
  const table = <div ref={scroll} className="md-table-scroll" role={overflow ? "region" : undefined} aria-label={overflow ? t("markdown.table") : undefined} tabIndex={overflow ? 0 : undefined}><table>{children}</table></div>;
  const controls = <div className="md-tools">
    {!draft && <><button onClick={() => void copy("markdown")}>{t("markdown.copyMarkdown")}</button><button onClick={() => void copy("tsv")}>{t("markdown.copyTsv")}</button><button onClick={() => void copy("html")}>{t("markdown.copyRich")}</button></>}
    <button ref={expandButton} onClick={() => setExpanded(!expanded)}>{t(expanded ? "markdown.close" : "markdown.expand")}</button>
    <span role="status">{status}</span>
  </div>;
  return <div className="md-table md-wide">
    {expanded ? <><button className="md-table-return" onClick={() => setExpanded(false)}>{t("markdown.tableOpen")}</button><Dialog label={t("markdown.table")} width={1100} className="md-expanded" onClose={() => setExpanded(false)}><div className="md">{controls}{table}</div></Dialog></> : <>{controls}{table}</>}
  </div>;
}
