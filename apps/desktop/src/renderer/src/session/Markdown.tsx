import { Component, createContext, lazy, memo, Suspense, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import { baseName, fileOfLink } from "@finx/client";
import { Lightbox } from "../composer/Tile";
import { useStore } from "../store";
import { parseCitation, useDocOpener } from "../docs/state";
import remarkGfm from "remark-gfm";
import remend from "remend";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import type { PluggableList } from "unified";
import { createMarkdownSlices, pendingText } from "./markdown/parse";
import { anchors, contentExtensions } from "./markdown/plugins";
import { texMath } from "./markdown/tex";
import { MarkdownTable } from "./markdown/Table";
import { CodeBlock, InlineCode, Link } from "./content";
import { DraftContext, LocalImages, useScope } from "./scope";

const MermaidBlock = lazy(() => import("./markdown/Mermaid"));
const SourceContext = createContext("");

/** One component tree throughout streaming and completion. AST-aware slices keep
 * settled blocks memoized; document-scoped references take the whole-document path.
 * How often text arrives while it is written is useSession's to pace. */
export function Markdown({ text, streaming = false, mode = "chat" }: { text: string; streaming?: boolean; mode?: "chat" | "document" | "compact" }) {
  const prefix = useId();
  const split = useRef(createMarkdownSlices());
  const blocks = useMemo(() => split.current(text, streaming), [text, streaming]);
  return <div className="md sel-text" data-mode={mode}>
    {blocks.map((block) => <Block key={block.id} text={block.text} pending={block.pending} prefix={prefix} offset={block.id} mode={mode} />)}
  </div>;
}

// Compatibility for callers; Chat uses Markdown directly so completion never
// changes the component type or remounts the code/table/diagram subtree.
export function DraftMarkdown({ text }: { text: string }) { return <Markdown text={text} streaming />; }

const Block = memo(function Block({ text, pending, prefix, offset, mode }: { text: string; pending: boolean; prefix: string; offset: number; mode: string }) {
  const { t } = useTranslation("session");
  const [mathPlugin, setMathPlugin] = useState<PluggableList>([]);
  const hasMath = /\$\$|```math|~~~math|\\[([]/.test(text);
  useEffect(() => {
    if (!hasMath) return;
    let live = true;
    Promise.all([import("rehype-katex"), import("katex/dist/katex.min.css")]).then(([module]) => {
      if (live) setMathPlugin([[module.default, { output: "htmlAndMathml", throwOnError: false, strict: "ignore", trust: false, maxExpand: 1000, maxSize: 20, errorColor: "inherit" }]]);
    }).catch(() => {});
    return () => { live = false; };
  }, [hasMath]);
  const rehypePlugins = useMemo<PluggableList>(() => [...mathPlugin, [anchors, { prefix, block: offset }]], [mathPlugin, prefix, offset]);
  const shown = pending ? remend(pendingText(text), { linkMode: "text-only", katex: true }) : text;
  return <DraftContext.Provider value={pending}><SourceContext.Provider value={text}>
    <RenderBoundary source={text}><ReactMarkdown remarkPlugins={mode === "document" ? documentPlugins : plugins} rehypePlugins={rehypePlugins} components={components} urlTransform={asWritten} remarkRehypeOptions={{ footnoteLabel: t("markdown.footnotes"), footnoteBackLabel: t("markdown.backToReference") }}>{shown}</ReactMarkdown></RenderBoundary>
  </SourceContext.Provider></DraftContext.Provider>;
});

class RenderBoundary extends Component<{ source: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: { source: string }) {
    if (this.state.failed && previous.source !== this.props.source) this.setState({ failed: false });
  }
  render() { return this.state.failed ? <pre>{this.props.source}</pre> : this.props.children; }
}

const web = /^https?:\/\//i;

/** Targets as the model wrote them: a link to a path or `README.md:12` would otherwise be dropped; only http and https ever become real links. */
const asWritten = (url: string) => url;

type HNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HNode[] };
const textOf = (n: HNode): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));

/** A `pre`'s code: its language (from `language-*`) and text. */
function codeOf(pre: HNode | undefined): { lang: string; text: string } | null {
  const code = pre?.children?.find((c) => c.type === "element" && c.tagName === "code");
  if (!code) return null;
  const names = code.properties?.className;
  const lang = (Array.isArray(names) ? names : [names]).map((c) => /^language-(\S+)/.exec(String(c ?? ""))?.[1]).find(Boolean) ?? "";
  return { lang, text: textOf(code).replace(/\n$/, "") };
}

/**
 * A citation of a document (document-editor-design §7.4): a small raised mark; hovering shows
 * the file, the page and the text cited, a click opens the document there. Grey once what it
 * points at is gone.
 */
function Cite({ docId, target, children }: { docId: string; target: string; children: ReactNode }) {
  const { t } = useTranslation("session");
  const docs = useDocOpener();
  const draft = useContext(DraftContext);
  const [found, setFound] = useState<{ title: string } | "gone" | null>(null);
  const look = () => {
    if (!docs || draft || found) return;
    void docs.locate(docId, target).then((r) => {
      if (!r) return setFound("gone");
      if ("locked" in r) return setFound({ title: t("doc.citeLocked", { name: baseName(r.path) }) });
      const text = r.anchor.kind === "text" || r.anchor.kind === "cells" ? (r.anchor.text ?? "") : "";
      const where = r.anchor.kind === "cells"
        ? `${baseName(r.path)} · ${r.anchor.sheet}!${r.anchor.range}`
        : t("doc.where", { name: baseName(r.path), page: r.anchor.page });
      setFound({ title: text ? `${where}\n${text.length > 120 ? text.slice(0, 120) + "…" : text}` : where });
    });
  };
  const gone = found === "gone";
  return (
    <button
      type="button"
      className={`cite ${gone ? "gone" : ""}`}
      title={gone ? t("doc.citeGone") : (found?.title ?? undefined)}
      onMouseEnter={look}
      onFocus={look}
      onClick={() => !draft && !gone && docs?.open({ doc_id: docId }, undefined, target)}
      disabled={!docs || draft}
    >
      {children}
    </button>
  );
}

/**
 * An image in a reply: its alt text, so a reply loads nothing from the network. In a bot's
 * conversation, one on this computer shows, and opens large: a model writes `![chart](chart.png)`
 * as readily as it sends the file.
 */
function ReplyImage({ src, alt }: { src?: string; alt?: string }) {
  const st = useStore();
  const scope = useScope();
  const allowed = useContext(LocalImages);
  const draft = useContext(DraftContext);
  const file = !draft && allowed && scope && src ? fileOfLink(src, window.finx?.platform === "win") : null;
  const [picture, setPicture] = useState<{ path: string; data: string } | null>(null);
  const [large, setLarge] = useState(false);
  useEffect(() => {
    if (!file || !scope) return;
    let live = true;
    st.call("files/read", { session_id: scope.session, path: file.path })
      .then((read) => live && setPicture(read.image ? { path: file.path, data: `data:${read.image.mime_type};base64,${read.image.data}` } : null))
      .catch(() => live && setPicture(null));
    return () => {
      live = false;
    };
  }, [file?.path, scope?.session]);
  if (!picture || picture.path !== file?.path || draft) return <span>{alt}</span>;
  return (
    <>
      <button className="md-img" title={alt || file?.path} aria-label={alt || file?.path} onClick={() => setLarge(true)}>
        <img src={picture.data} alt={alt ?? ""} draggable={false} />
      </button>
      {large && <Lightbox src={picture.data} caption={alt || undefined} onClose={() => setLarge(false)} />}
    </>
  );
}

const components: Components = {
  a: ({ href, children, node, ...props }) => {
    if (href?.startsWith("#")) return <Anchor href={href} {...props}>{children}</Anchor>;
    const cite = href ? parseCitation(href) : null;
    if (cite) return <Cite docId={cite.doc_id} target={cite.target}>{children}</Cite>;
    return <Link href={href}>{children}</Link>;
  },
  img: ({ src, alt }) => <ReplyImage src={typeof src === "string" ? src : undefined} alt={alt} />,
  // Inline code only: a block's is drawn by its `pre`, coloured when it names its language.
  code: ({ children }) => <InlineCode>{children}</InlineCode>,
  pre: ({ node, children }) => {
    const code = codeOf(node as HNode | undefined);
    if (code?.lang.toLowerCase() === "mermaid") return <Suspense fallback={<CodeBlock lang="mermaid" text={code.text} />}><MermaidBlock text={code.text} /></Suspense>;
    return code ? <CodeBlock lang={code.lang} text={code.text} /> : <pre>{children}</pre>;
  },
  table: ({ children, node }) => <Table sourceStart={node?.position?.start.offset} sourceEnd={node?.position?.end.offset}>{children}</Table>,
  details: ({ children, node }) => <Disclosure title={String(node?.properties?.dataTitle ?? node?.properties?.["data-title"] ?? "")}>{children}</Disclosure>,
};

type Node = { type: string; value?: string; url?: string; children?: Node[] };

/** Chinese text and punctuation: a bare link ends before them ("见 https://x.io，然后" links https://x.io). */
const wide = /[　-〿㐀-鿿＀-￯]/;

/**
 * Models write for chat: a single newline is a line break, and a bare link
 * stops where Chinese text starts (GFM would carry it to the next space).
 */
function chatText() {
  return (tree: Node) => {
    const walk = (n: Node) => {
      if (!n.children) return;
      const out: Node[] = [];
      for (const c of n.children) {
        if (c.type === "text" && c.value?.includes("\n")) {
          c.value.split("\n").forEach((v, i) => {
            if (i > 0) out.push({ type: "break" });
            if (v) out.push({ type: "text", value: v });
          });
          continue;
        }
        const label = c.type === "link" && c.children?.length === 1 && c.children[0].type === "text" ? (c.children[0].value ?? "") : "";
        const cut = label.search(wide);
        if (cut > 0 && (web.test(label) || label.startsWith("www."))) {
          const shown = label.slice(0, cut);
          out.push({ ...c, url: web.test(shown) ? shown : `http://${shown}`, children: [{ type: "text", value: shown }] });
          out.push({ type: "text", value: label.slice(cut) });
          continue;
        }
        walk(c);
        out.push(c);
      }
      n.children = out;
    };
    walk(tree);
  };
}

const documentPlugins: PluggableList = [[remarkGfm, { singleTilde: false }], [remarkMath, { singleDollarTextMath: false }], remarkDirective, texMath, contentExtensions];
const plugins: PluggableList = [...documentPlugins, chatText];

function Table({ children, sourceStart, sourceEnd }: { children: ReactNode; sourceStart?: number; sourceEnd?: number }) {
  const source = useContext(SourceContext);
  return <MarkdownTable source={source.slice(sourceStart, sourceEnd)}>{children}</MarkdownTable>;
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation("session");
  return <details className="md-details"><summary>{title || t("markdown.details")}</summary>{children}</details>;
}

function Anchor({ href, children, ...props }: { href: string; children?: ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const draft = useContext(DraftContext);
  return <a {...props} href={draft ? undefined : href} onClick={(e) => {
    e.preventDefault();
    if (draft) return;
    const root = e.currentTarget.closest(".md");
    let id = href.slice(1);
    try { id = decodeURIComponent(id); } catch { /* literal fragment */ }
    const target = root?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"], [data-heading="${CSS.escape(id)}"]`);
    if (!target) return;
    for (let parent = target.parentElement; parent && parent !== root; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    target.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    target.tabIndex = -1; target.focus({ preventScroll: true });
  }}>{children}</a>;
}
