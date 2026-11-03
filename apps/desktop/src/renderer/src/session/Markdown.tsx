import { memo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import { baseName } from "@finx/client";
import { parseCitation, useDocOpener } from "../docs/state";
import remarkGfm from "remark-gfm";
import remend from "remend";
import { splitBlocks, withoutOpenTable } from "@finx/client";
import { CodeBlock, InlineCode, Link } from "./content";
import { DraftContext } from "./scope";

/**
 * The model's reply as GitHub Markdown, rendered as React elements (raw HTML
 * stays text). Web pages, files and code blocks become what they point at
 * (content-actions-design): only http and https links are real links; images
 * show their alt text, so a reply never loads anything.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md sel-text">
      <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={asWritten}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * A reply the model is still writing: its finished blocks as they will
 * stay, each parsed once, then the last one with what is still open closed
 * (remend), or without a table that has no delimiter row yet, so nothing
 * shows as raw Markdown on its way.
 */
export function DraftMarkdown({ text }: { text: string }) {
  const blocks = splitBlocks(text);
  const last = withoutOpenTable(blocks.pop() ?? "");
  return (
    <div className="md sel-text">
      {blocks.map((b, i) => (
        <Block key={i} text={b} />
      ))}
      {/* Still being written: nothing in it acts yet. */}
      {last.trim() !== "" && (
        <DraftContext.Provider value={true}>
          <Block key={blocks.length} text={remend(last, { linkMode: "text-only", katex: false })} />
        </DraftContext.Provider>
      )}
    </div>
  );
}

const Block = memo(function Block({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={asWritten}>
      {text}
    </ReactMarkdown>
  );
});

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
  const [found, setFound] = useState<{ title: string } | "gone" | null>(null);
  const look = () => {
    if (!docs || found) return;
    void docs.locate(docId, target).then((r) => {
      if (!r) return setFound("gone");
      if ("locked" in r) return setFound({ title: t("doc.citeLocked", { name: baseName(r.path) }) });
      const text = r.anchor.kind === "text" ? r.anchor.text : "";
      const where = t("doc.where", { name: baseName(r.path), page: r.anchor.page });
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
      onClick={() => !gone && docs?.open({ doc_id: docId }, undefined, target)}
      disabled={!docs}
    >
      {children}
    </button>
  );
}

const components: Components = {
  a: ({ href, children }) => {
    const cite = href ? parseCitation(href) : null;
    if (cite) return <Cite docId={cite.doc_id} target={cite.target}>{children}</Cite>;
    return <Link href={href}>{children}</Link>;
  },
  img: ({ alt }) => <span>{alt}</span>,
  // Inline code only: a block's is drawn by its `pre`, coloured when it names its language.
  code: ({ children }) => <InlineCode>{children}</InlineCode>,
  pre: ({ node, children }) => {
    const code = codeOf(node as HNode | undefined);
    return code ? <CodeBlock lang={code.lang} text={code.text} /> : <pre>{children}</pre>;
  },
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
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

const plugins = [remarkGfm, chatText];
