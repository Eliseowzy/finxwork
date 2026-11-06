import { useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "../../components";
import { CodeBlock } from "../content";
import { DraftContext } from "../scope";

function Svg({ svg }: { svg: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    // SVG was produced by Mermaid strict mode from bounded, config-free input.
    root.innerHTML = `<style>:host{display:block}svg{display:block;max-width:100%;height:auto;margin:auto}.node rect,.node polygon,.node circle,.node path{filter:none!important}.node rect{rx:8px;ry:8px}</style>${svg}`;
  }, [svg]);
  return <div ref={ref} className="md-diagram-svg" />;
}

export default function MermaidBlock({ text }: { text: string }) {
  const { t } = useTranslation("session");
  const draft = useContext(DraftContext);
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const [result, setResult] = useState<{ text: string; dark: boolean; svg?: string; error?: boolean }>();
  const [source, setSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (draft) return;
    let live = true;
    import("./mermaid-render").then(({ renderDiagram }) => renderDiagram(text, dark))
      .then((svg) => { if (live) setResult({ text, dark, svg }); })
      .catch(() => { if (live) setResult({ text, dark, error: true }); });
    return () => { live = false; };
  }, [text, dark, draft]);
  const current = result?.text === text && result.dark === dark ? result : undefined;
  const copy = () => navigator.clipboard.writeText(text).then(() => setCopyStatus(t("markdown.copied"))).catch(() => setCopyStatus(t("markdown.copyFailed")));
  const save = () => {
    if (!current?.svg) return;
    const url = URL.createObjectURL(new Blob([current.svg], { type: "image/svg+xml" }));
    const a = document.createElement("a"); a.href = url; a.download = "finxwork-diagram.svg"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="md-diagram md-wide">
    <div className="md-tools"><span>Mermaid</span><button aria-pressed={source} onClick={() => setSource(!source)}>{t(source ? "markdown.diagram" : "markdown.source")}</button>
      {!draft && <button onClick={() => void copy()}>{t("content.copy")}</button>}
      {current?.svg && <><button onClick={() => setExpanded(true)}>{t("markdown.expand")}</button><button onClick={save}>{t("markdown.exportSvg")}</button></>}
      <span role="status">{copyStatus}</span>
    </div>
    {draft || source || current?.error ? <><CodeBlock lang="mermaid" text={text} />{current?.error && <p className="md-render-note" role="status">{t("markdown.diagramFailed")}</p>}</> : current?.svg ? <Svg svg={current.svg} /> : <div className="md-diagram-loading" role="status">{t("markdown.rendering")}</div>}
    {expanded && current?.svg && <Dialog label={t("markdown.diagram")} width={1100} className="md-expanded" onClose={() => setExpanded(false)}><div className="md-tools"><button onClick={() => setExpanded(false)}>{t("markdown.close")}</button></div><Svg svg={current.svg} /></Dialog>}
  </div>;
}
