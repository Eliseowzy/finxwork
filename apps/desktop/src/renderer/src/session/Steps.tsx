import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toolObject, toolOutput, type ToolView, type WorkItem } from "@finx/client";
import { toolVerb, workText } from "../format";
import { Icon } from "../icons";
import { Code } from "./Code";

/**
 * What the model did between its words: one step alone as its own line,
 * several as one grey line ("Read 2 files, ran 3 commands") that opens to
 * show each. Folded until the owner opens it; the one running spins.
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
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  return (
    <div className={`tgroup ${open ? "open" : ""}`}>
      <button className="tg-h" aria-expanded={open} onClick={() => setOpen(!open)}>
        {live && <span className="mini-spin" role="img" aria-label={t("chat.inProgress")} />}
        <span>{workText(items)}</span>
        <Icon name="caret" className="chev" />
      </button>
      {open && (
        <div className="tg-b">
          {items.map((it) => (
            <Item key={it.key} it={it} />
          ))}
        </div>
      )}
    </div>
  );
}

function Item({ it }: { it: WorkItem }) {
  return it.kind === "thinking" ? <Thinking text={it.text} redacted={it.redacted} live={it.live} /> : <ToolRow tool={it.tool} />;
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
      <button className="th" onClick={() => body && setOpen(!open)} aria-expanded={body ? open : undefined}>
        {live && <span className="mini-spin" role="img" aria-label={t("chat.inProgress")} />}
        <span className="vb">{live ? t("chat.thinking") : t("chat.thought")}</span>
        <span className="sm2">{gist}</span>
        {body && <Icon name="caret" className="chev" />}
      </button>
      {body && <div className="out sel-text">{text.trim()}</div>}
    </div>
  );
}

/** One tool call: what it did, and its output when opened. A command reads as code. */
function ToolRow({ tool }: { tool: ToolView }) {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const [big, setBig] = useState(false);
  const output = toolOutput(tool);
  // Images a tool returned (a browser screenshot, an image read): a thumbnail, larger on a click.
  const images = (tool.result?.content ?? []).flatMap((c) => (c.type === "image" ? [c] : []));
  const spinning = tool.state === "running" || tool.state === "streaming";
  // A message to a sub-agent reads as one: "Sent to name: the message".
  const toAgent = tool.name === "send_message";
  const object = toAgent ? t("agents.messageObject", { to: String(tool.args.to ?? ""), message: String(tool.args.message ?? "").split("\n")[0] }) : toolObject(tool);
  const verb = toAgent ? (spinning || tool.state === "pending" ? t("agents.sending") : t("agents.sent")) : toolVerb(tool);
  return (
    <div className={`tool ${tool.state === "failed" ? "err" : ""} ${tool.state === "denied" || tool.state === "awaiting_approval" ? "denied" : ""} ${open && output ? "open" : ""}`}>
      <button className="th" onClick={() => output && setOpen(!open)} aria-expanded={output ? open : undefined}>
        {spinning && <span className="mini-spin" role="img" aria-label={t("chat.inProgress")} />}
        <span className="vb">{verb}</span>
        {tool.category === "execute" ? (
          <code className="sm2 cmd" title={tool.title}>
            <Code text={object} lang="bash" />
          </code>
        ) : (
          <span className="sm2" title={tool.title}>{object}</span>
        )}
        {output && <Icon name="caret" className="chev" />}
      </button>
      {images.length > 0 && (
        <div className={`tool-shots ${big ? "big" : ""}`}>
          {images.map((img, i) => (
            <button key={i} className="tool-shot" aria-label={t("chat.image")} aria-expanded={big} onClick={() => setBig(!big)}>
              <img src={`data:${img.mime_type};base64,${img.data}`} alt="" />
            </button>
          ))}
        </div>
      )}
      {output && <div className="out sel-text">{output}</div>}
    </div>
  );
}
