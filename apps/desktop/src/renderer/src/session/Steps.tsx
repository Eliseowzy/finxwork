import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { callTarget, toolObject, toolOutput, type ToolView, type WorkItem } from "@finx/client";
import { doingText, toolVerb, workText } from "../format";
import { Icon } from "../icons";
import { useStore } from "../store";
import { Lightbox } from "../composer/Tile";
import { Code } from "./Code";
import { stepMenu } from "./contentMenus";
import { useScope } from "./scope";
import { SearchResults, searchCall, searchDetails } from "./SearchResults";
import { handoffOf } from "./Yours";
import { DeckEditActions } from "./DeckEditActions";
import { deckEditDetails } from "../docs/pptx/deckEdit";
import { DocxEditActions } from "./DocxEditActions";
import { docxEditDetails } from "../docs/docx/aiPrompt";

/**
 * What the model did between its words: one step alone as its own line,
 * several as one grey line ("Read 2 files, ran 3 commands") that opens to
 * show each. Folded until the owner opens it; what is in progress shimmers.
 */
export function Work({ items, live, flat = false }: { items: WorkItem[]; live: boolean; flat?: boolean }) {
  // A call waiting for approval shows in the approval at the bottom, as the baseline's pending question does.
  const shown = items.filter((it) => it.kind !== "tool" || it.tool.state !== "awaiting_approval");
  if (shown.length === 0) return null;
  // flat: every step on its own line (a sub-agent's work in the background panel).
  if (flat) return <>{shown.map((it) => <Item key={it.key} it={it} />)}</>;
  if (shown.length === 1) return <Item it={shown[0]} />;
  return <Group items={shown} live={live} />;
}

function Group({ items, live }: { items: WorkItem[]; live: boolean }) {
  // A deck change stays in sight under the folded line, to look at or take back.
  const edits = items.flatMap((it) => (it.kind === "tool" && (deckEditOf(it.tool) || docxEditOf(it.tool)) ? [it.tool] : []));
  return (
    <>
      <Fold title={workText(items)} live={live} body={items.map((it) => <Item key={it.key} it={it} card={false} />)} />
      {edits.map((tool) => <DeckEdit key={tool.call_id} tool={tool} />)}
    </>
  );
}

/** A `deck_edit` that changed the deck, itself or (deferred, as the deck tools are) through call_tool. */
const deckEditOf = (tool: ToolView) => (callTarget(tool.name, tool.args).name === "deck_edit" && tool.state === "done" ? deckEditDetails(tool.result?.details) : null);

/** A Word change (docx_edit, docx_review), as deckEditOf. */
const docxEditOf = (tool: ToolView) => {
  const name = callTarget(tool.name, tool.args).name;
  return (name === "docx_edit" || name === "docx_review") && tool.state === "done" && !tool.result?.is_error ? docxEditDetails(tool.result?.details) : null;
};

function DeckEdit({ tool }: { tool: ToolView }) {
  const st = useStore();
  const scope = useScope();
  if (!st.rpc || !scope) return null;
  const docx = docxEditOf(tool);
  if (docx) return <DocxEditActions details={docx} rpc={st.rpc} session={scope.session} review={callTarget(tool.name, tool.args).name === "docx_edit"} />;
  const details = deckEditOf(tool);
  return details ? <DeckEditActions details={details} rpc={st.rpc} session={scope.session} /> : null;
}

/** Calls running at once, as one line ("Reading 2 files") with `after` on it, each on its own line when opened. */
export function RunningCalls({ tools, after }: { tools: ToolView[]; after?: ReactNode }) {
  return <Fold title={doingText(tools)} live after={after} body={tools.map((x) => <ToolRow key={x.call_id} tool={x} />)} />;
}

/** A line that opens to show the steps under it; it shimmers while they go. */
function Fold({ title, live, after, body }: { title: string; live: boolean; after?: ReactNode; body: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tgroup ${open ? "open" : ""}`}>
      <button className={`tg-h ${live ? "shimmer" : ""}`} aria-expanded={open} aria-busy={live || undefined} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        {after}
        <Icon name="chevD" className="chev" />
      </button>
      {open && <div className="tg-b">{body}</div>}
    </div>
  );
}

function Item({ it, card = true }: { it: WorkItem; card?: boolean }) {
  return it.kind === "thinking" ? <Thinking text={it.text} redacted={it.redacted} live={it.live} /> : <ToolRow tool={it.tool} card={card} />;
}

/** The model's thinking: a quiet line with where it got to, the whole of it when opened. */
function Thinking({ text, redacted, live }: { text: string; redacted: boolean; live: boolean }) {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const lines = text.trim().split("\n").filter((l) => l.trim() !== "");
  // While it thinks, the line it is on; after, how it began.
  const gist = redacted ? t("chat.thinkingHidden") : ((live ? lines.at(-1) : lines[0]) ?? "");
  const body = !redacted && text.trim() !== "";
  return (
    <div className={`tool think ${open && body ? "open" : ""}`}>
      <button className={`th ${live ? "shimmer" : ""}`} onClick={() => body && setOpen(!open)} aria-expanded={body ? open : undefined} aria-busy={live || undefined}>
        <span className="vb">{live ? t("chat.thinking") : t("chat.thought")}</span>
        <span className="sm2">{gist}</span>
        {body && <Icon name="chevD" className="chev" />}
      </button>
      {body && <div className="out sel-text">{text.trim()}</div>}
    </div>
  );
}

/**
 * The thinking in progress, in the working line: `children` (what it does,
 * how long) on a line that opens it, and under it its last three lines as
 * they come, older ones fading out at the top. Opened, the whole of it,
 * following the end unless the owner scrolls up.
 */
export function LiveThinking({ text, children }: { text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const body = text.trim();
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (open && atEnd.current) el.scrollTop = el.scrollHeight;
    // Closed, what is pushed out at the top is not in scrollHeight: measure what is inside.
    setOver((el.firstElementChild as HTMLElement).offsetHeight > el.clientHeight + 1);
  }, [body, open]);
  return (
    <>
      <button
        className="wk-line tk-h"
        onClick={() => {
          if (!body) return;
          atEnd.current = true;
          setOpen(!open);
        }}
        aria-expanded={body ? open : undefined}
      >
        {children}
        {body && <Icon name="chevD" className="chev" />}
      </button>
      {body && (
        <div
          ref={box}
          className={`tk-peek sel-text ${open ? "open" : over ? "over" : ""}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          }}
        >
          <div>{body}</div>
        </div>
      )}
    </>
  );
}

/**
 * One tool call: what it did, and its output when opened. A command reads as
 * code. While the model is still writing a call, what it is on is not known
 * yet: the verb alone ("Editing…"). `after`: what follows on the line (how long the work has run).
 */
export function ToolRow({ tool, after, card = true }: { tool: ToolView; after?: ReactNode; card?: boolean }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const scope = useScope();
  const [open, setOpen] = useState(false);
  const [large, setLarge] = useState<string | null>(null);
  const output = toolOutput(tool);
  // Images a tool returned (a browser screenshot, an image read): a thumbnail, over the window on a click.
  const images = (tool.result?.content ?? []).flatMap((c) => (c.type === "image" ? [c] : []));
  const spinning = tool.state === "running" || tool.state === "pending" || tool.state === "streaming";
  const unknown = tool.state === "streaming" && tool.title === tool.name;
  // A message to an agent reads as one: "Sent to name: the message".
  const toAgent = tool.name === "send_message";
  const address = String(tool.args.to ?? "");
  // A page handed to the user says what they were asked.
  const handoff = handoffOf({ name: tool.name, args: tool.args });
  // A web search reads as the words searched for, and opens to the pages found.
  const search = searchCall(tool);
  const found = search && searchDetails(tool);
  const named = search
    ? search.query + (search.sites.length ? t("webSearch.only", { sites: search.sites.join(t("webSearch.siteSeparator")) }) : "")
    : toAgent ? t("agents.messageObject", { to: address === "main" || address === "parent" ? t("agents.mainAgent") : address, message: String(tool.args.message ?? "").split("\n")[0] }) : (handoff ?? toolObject(tool));
  // The kernel's title for a page opened in the user's own browser.
  // A Word change names its document, not the path the kernel was given.
  const docx = docxEditOf(tool);
  const object = docx ? docx.path.split(/[\\/]/).pop() ?? docx.path : named.replace(/ in your browser$/, t("yours.inYourBrowser"));
  const verb = search && tool.state === "failed" ? t("webSearch.failed") : toAgent ? (spinning || tool.state === "pending" ? t("agents.sending") : t("agents.sent")) : handoff !== null && tool.state === "done" ? t("yours.handoff.handled") : toolVerb(tool);
  return (
    <div
      className={`tool ${tool.state === "failed" ? "err" : ""} ${tool.state === "denied" || tool.state === "awaiting_approval" ? "denied" : ""} ${open && output ? "open" : ""}`}
      // A file's menu for reading and editing, a command's for a command (content-actions-design §7.1); the left click still opens it.
      onContextMenu={(e) => {
        if (tool.state === "streaming" || !stepMenu(st, tool, scope)) return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <button className={`th ${spinning ? "shimmer" : ""}`} onClick={() => output && setOpen(!open)} aria-expanded={output ? open : undefined} aria-busy={spinning || undefined}>
        <span className="vb">{unknown ? `${verb}…` : verb}</span>
        {unknown ? null : tool.category === "execute" ? (
          <code className="sm2 cmd" title={tool.title}>
            <Code text={object} lang="bash" />
          </code>
        ) : (
          <span className="sm2" title={tool.title}>{object}</span>
        )}
        {after}
        {output && <Icon name="chevD" className="chev" />}
      </button>
      {images.length > 0 && (
        <div className="tool-shots">
          {images.map((img, i) => {
            const src = `data:${img.mime_type};base64,${img.data}`;
            return (
              <button key={i} className="tool-shot" aria-label={t("composer.view", { name: t("chat.image") })} onClick={() => setLarge(src)}>
                <img src={src} alt="" />
              </button>
            );
          })}
        </div>
      )}
      {large && <Lightbox src={large} onClose={() => setLarge(null)} />}
      {found ? open && <SearchResults details={found} /> : output && <div className="out sel-text">{output}</div>}
      {/* A change the agent made to a presentation: its page, and 撤销 (in a group, under its line). */}
      {card && <DeckEdit tool={tool} />}
    </div>
  );
}
