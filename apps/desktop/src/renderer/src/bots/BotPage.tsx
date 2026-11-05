import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { baseName, botChat, botWorking, busyBubble, docViewingBlock, pendingApproval, processSteps, type BotItem, type WorkingAgent, type SessionView, type Step } from "@finx/client";
import type { BotSummary, UserMessage } from "@finx/protocol";
import { SidebarToggle } from "../components";
import { addAttachments, fromInput, toInput, type Attachment } from "../composer/attachments";
import { useComposerInbox } from "../composer/inbox";
import { Composer } from "../composer/Composer";
import { useCommands } from "../composer/skills";
import { Tile } from "../composer/Tile";
import { durationText, timeLine } from "../format";
import { GlassBar } from "../glass";
import { Icon } from "../icons";
import { DocContext } from "../docs/state";
import { viewingDoc } from "../files/state";
import { AgentCard, AgentMessageCard, ReportCard } from "../session/Agents";
import { Approval } from "../session/Approval";
import { MessageTime } from "../session/Chat";
import { FailureCard, PastFailure } from "../session/Failure";
import { Markdown } from "../session/Markdown";
import { useSidePanels, SidePanelButtons, SidePanelViews } from "../session/SidePanels";
import { ContentScope, LocalImages } from "../session/scope";
import { Work } from "../session/Steps";
import { selectionMenu } from "../session/contentMenus";
import { useNow, useStore } from "../store";
import { thingsText } from "./actions";
import { BotAvatar } from "./Avatar";
import { BotPanel } from "./BotPanel";
import { Question, SentFiles } from "./Messages";
import { useBotSession } from "./useBotSession";

/** Bot mode's pause before a time line (bot-mode-design §6.6). */
const PAUSE = 10 * 60_000;
/** A bot's settings out, in the one place beside the conversation. */
const OPEN_SETTINGS = { botPanel: true, files: false, filesMax: false, browser: false, browserMax: false };

/**
 * A bot's page (bot-mode-design §6.5–§6.17): its avatar and name in the
 * middle of the top, as in a chat app, which open its settings; the
 * conversation in bubbles on both sides, and the composer. The bot says only
 * what it sends; what it did on the way is a message's process, opened on
 * hover. What it is doing shows in its list row and the conversation.
 */
export function BotPage({ bot }: { bot: BotSummary }) {
  const st = useStore();
  const { t } = useTranslation("bots");
  const [view, session, loadEarlier] = useBotSession(bot.id, bot.session_id ?? undefined);
  useMarkRead(bot);
  useBotPermission(bot.id, view, session);
  const scope = useMemo(() => (session && view ? { session, cwd: view.info.cwd } : null), [session, view?.info.cwd]);
  const panels = useSidePanels(session ?? "", view);
  const busy = botWorking(bot);
  // One panel at a time: the file panel or the browser coming out puts the settings away.
  const taken = panels.files || panels.browser;
  useEffect(() => {
    if (taken && st.botPanel) st.set({ botPanel: false });
  }, [taken]);
  const settings = st.botPanel && !taken;
  return (
    <DocContext.Provider value={panels.opener}>
    <div className={`spage bot ${panels.browser || panels.files || settings ? "bgopen" : ""} ${panels.max ? "brmax" : ""}`}>
      <div className="scol">
        <GlassBar className="ctool drag">
          <SidebarToggle />
          <button
            className="bhead"
            title={t("head.settings")}
            aria-expanded={settings}
            onClick={() => st.set({ ...OPEN_SETTINGS, botPanel: !settings })}
          >
            <BotAvatar bot={bot} size={22} busy={busy} />
            <span className="bhead-n">{bot.name}</span>
            <Icon name="chevR" className="bhead-go" />
          </button>
          <span className="bhead-gap" />
          {session && <SidePanelButtons panels={panels} />}
        </GlassBar>
        <ContentScope value={scope}>
          <div className="dwrap" onContextMenu={() => selectionMenu(st)}>
            <div className="dmain">
              {view && session ? (
                <LocalImages.Provider value={true}>
                  <BotChat bot={bot} view={view} session={session} loadEarlier={loadEarlier} />
                </LocalImages.Provider>
              ) : (
                <div className="empty">
                  <span className="mini-spin" />
                </div>
              )}
            </div>
          </div>
        </ContentScope>
      </div>
      {session && <SidePanelViews panels={panels} view={view} />}
      {settings && <BotPanel bot={bot} view={view} session={session} onClose={() => st.set({ botPanel: false })} />}
    </div>
    </DocContext.Provider>
  );
}

/**
 * What bots may do (bot-mode-design §6.13): Full Access by default. A conversation gets that
 * default once, so what is picked in it afterwards stays.
 */
function useBotPermission(bot: string, view: SessionView | null, session: string | null) {
  const st = useStore();
  useEffect(() => {
    if (!view || !session || st.botDefaulted[bot] === session) return;
    st.set({ botDefaulted: { ...st.botDefaulted, [bot]: session } });
    if (view.info.permission_mode !== "bypass-permissions") void st.op(session, { type: "set_permission_mode", mode: "bypass-permissions" });
  }, [bot, session, view === null]);
}

/**
 * What bots may do, said once above the composer as a key notice is (bot-mode-design §6.13): the
 * setting is out of sight, so this says it holds and leads to it. It covers nothing, so it stays
 * until Got it or the settings are opened, which close it for good.
 */
function FullAccessNote({ onSettings, onClose }: { onSettings: () => void; onClose: () => void }) {
  const { t } = useTranslation("bots");
  return (
    <div className="knote" role="status">
      <div className="knote-h">
        <Icon name="warn" className="knote-i" />
        <b>{t("fullAccess.title")}</b>
      </div>
      <p className="knote-b">{t("fullAccess.body")}</p>
      <div className="appr-f">
        <span className="appr-sp" />
        <button className="btn" onClick={onSettings}>{t("fullAccess.settings")}</button>
        <button className="btn primary" onClick={onClose}>{t("fullAccess.ok")}</button>
      </div>
    </div>
  );
}

/**
 * Nothing is unread while the owner looks: the bot is on screen, the window in front and the
 * screen not locked (bot-design §5.3). What comes meanwhile is unread until they are back.
 */
function useMarkRead(bot: BotSummary) {
  const st = useStore();
  const unread = bot.unread ?? 0;
  useEffect(() => {
    const read = async () => {
      if ((bot.unread ?? 0) === 0 || !document.hasFocus() || (await window.finx?.screenLocked())) return;
      void st.call("bots/read", { bot_id: bot.id }).catch(() => {});
    };
    void read();
    window.addEventListener("focus", read);
    const offUnlocked = window.finx?.onScreenUnlocked(() => void read());
    return () => {
      window.removeEventListener("focus", read);
      offUnlocked?.();
    };
  }, [bot.id, unread, st.call]);
}

function BotChat({ bot, view, session, loadEarlier }: { bot: BotSummary; view: SessionView; session: string; loadEarlier: () => Promise<void> }) {
  const { t } = useTranslation("bots");
  const st = useStore();
  const items = useMemo(() => botChat(view), [view]);
  const busy = busyBubble(view);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dock, setDock] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  // What was on screen when the page opened slides in no more; what comes after does.
  const seen = useRef<Set<string> | null>(null);
  seen.current ??= new Set(items.map((i) => i.key));

  // Earlier history, a page at a time, as the owner nears the top.
  const [paging, setPaging] = useState(false);
  const asking = useRef(false);
  const earlier = () => {
    if (asking.current || !view.before) return;
    asking.current = true;
    setPaging(true);
    loadEarlier().finally(() => {
      asking.current = false;
      setPaging(false);
    });
  };
  // Follow the conversation: open at its end, stay there as it grows unless the owner scrolled up.
  const atEnd = useRef(true);
  const [away, setAway] = useState(false);
  const firstKey = items[0]?.key;
  const fromEnd = useRef<number | null>(null);
  const lastFirst = useRef(firstKey);
  if (firstKey !== lastFirst.current && scroll.current) fromEnd.current = scroll.current.scrollHeight - scroll.current.scrollTop;
  useLayoutEffect(() => {
    const el = scroll.current;
    lastFirst.current = firstKey;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
    else if (el && fromEnd.current !== null) el.scrollTop = el.scrollHeight - fromEnd.current;
    fromEnd.current = null;
    if (el && el.scrollTop < el.clientHeight * 1.5) earlier();
  }, [items, busy?.typing, busy?.agents.length, dock]);
  // What grows at the end without changing the items.
  const follow = () => {
    const el = scroll.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  };
  const onScroll = () => {
    const el = scroll.current;
    if (!el) return;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    atEnd.current = below < 80;
    setAway(below > 240);
    if (el.scrollTop < el.clientHeight * 1.5) earlier();
  };
  // What grows on its own, a picture read after its message showed, stays in view at the end.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!body.current) return;
    const follow = new ResizeObserver(() => {
      if (atEnd.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    follow.observe(body.current);
    return () => follow.disconnect();
  }, []);
  const toEnd = () => {
    const el = scroll.current;
    if (!el) return;
    atEnd.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  const empty = items.length === 0 && !busy;
  const working = busy?.agents.length ?? 0;
  return (
    <>
      <div className="cscroll" ref={scroll} onScroll={onScroll}>
        <div className="dbody" ref={body} style={{ paddingBottom: dock + 40 }}>
          {view.before && (
            <div className="tdiv earlier">
              {paging ? <span className="mini-spin" aria-label={t("chat.loadingEarlier")} /> : <button className="link" onClick={earlier}>{t("chat.earlier")}</button>}
            </div>
          )}
          {empty ? (
            <div className="bempty">
              <BotAvatar bot={bot} size={64} />
              <h3>{bot.name}</h3>
              <p>{t("chat.empty")}</p>
            </div>
          ) : (
            <div className="tr bots" role="log" aria-label={t("chat.log")}>
              {items.map((item, i) => {
                const prev = items[i - 1];
                const fresh = !seen.current!.has(item.key);
                const line = <TimeSince at={item.ts} previous={prev?.ts} />;
                const message = (shown: React.ReactNode, copy?: string) => (
                  <BotMessage
                    key={item.key}
                    item={item as SentItem}
                    fresh={fresh}
                    line={line}
                    copy={copy}
                    open={open.has(item.key)}
                    onProcess={() => setOpen((o) => (o.has(item.key) ? new Set([...o].filter((k) => k !== item.key)) : new Set([...o, item.key])))}
                  >
                    {shown}
                  </BotMessage>
                );
                switch (item.kind) {
                  case "user":
                    return <UserBubble key={item.key} item={item} fresh={fresh} line={line} />;
                  case "bot":
                    return message(
                      <div className="bbub">
                        <Markdown text={item.text} />
                      </div>,
                      item.text,
                    );
                  case "attachment":
                    return message(<SentFiles files={item.files} text={item.text} />, item.text);
                  case "question":
                    return message(
                      <Question
                        text={item.text}
                        options={item.options}
                        open={item.open}
                        // A tapped answer is the owner's message: while the bot works, it waits for the step under way (bot-design §3.1).
                        onAnswer={(label) => st.op(session, { type: "prompt", input: [{ type: "text", text: label }], mode: view.live ? "steer" : undefined })}
                      />,
                      item.text,
                    );
                  case "failure":
                    return item.last ? <FailureCard key={item.key} error={item.error} working={working} sessionId={session} model={view.info.model} /> : <PastFailure key={item.key} error={item.error} />;
                }
              })}
              {busy && <BusyBubble busy={busy} retry={view.live?.retry} onOpen={follow} />}
            </div>
          )}
        </div>
      </div>
      <button className={`tobottom ${away ? "on" : ""}`} style={{ "--dock": `${dock}px` } as CSSProperties} aria-label={t("chat.toBottom")} title={t("chat.toBottom")} tabIndex={away ? 0 : -1} aria-hidden={!away} onClick={toEnd}>
        <Icon name="arrowDown" />
      </button>
      <BotDock bot={bot} view={view} session={session} onHeight={setDock} />
    </>
  );
}

/** A time line before a message after a pause of ten minutes, and before the first. */
function TimeSince({ at, previous }: { at: number; previous: number | undefined }) {
  const now = useNow(60_000);
  const text = timeLine(new Date(at), previous === undefined ? undefined : new Date(previous), now, PAUSE);
  return text ? <div className="tdiv">{text}</div> : null;
}

function UserBubble({ item, fresh, line }: { item: Extract<BotItem, { kind: "user" }>; fresh: boolean; line: React.ReactNode }) {
  const { t } = useTranslation("bots");
  return (
    <>
      {line}
      <div className={`um ${fresh ? "add-anim" : ""} ${item.queued ? "queued" : ""}`} title={item.queued ? t("chat.queued") : undefined}>
        {(item.images.length > 0 || item.files.length > 0) && (
          <div className="um-att">
            {item.images.map((im, i) => (
              <Tile key={i} kind="image" src={`data:${im.mime_type};base64,${im.data}`} />
            ))}
            {item.files.map((f) => (
              <Tile key={f} kind={/[\\/]$/.test(f) ? "folder" : "file"} path={f} name={baseName(f)} />
            ))}
          </div>
        )}
        {item.text !== "" && <div className="bub sel-text">{item.text}</div>}
        <div className="msg-act">
          <span className="msg-meta">
            <MessageTime at={new Date(item.ts)} />
          </span>
          <CopyButton text={item.text} />
        </div>
      </div>
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation("bots");
  const [done, setDone] = useState(false);
  return (
    <button className="tb" aria-label={t("chat.copy")} title={t("chat.copy")} onClick={() => navigator.clipboard.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}>
      <Icon name={done ? "check" : "copy"} className="sm" />
    </button>
  );
}

type SentItem = Extract<BotItem, { kind: "bot" | "attachment" | "question" }>;

/** A message from the bot: what it sent, its time and buttons beside it on hover, and its process under it. */
function BotMessage({ item, fresh, line, copy, open, onProcess, children }: {
  item: SentItem; fresh: boolean; line: React.ReactNode; copy?: string; open: boolean; onProcess: () => void; children: React.ReactNode;
}) {
  const { t } = useTranslation("bots");
  // Thinking and private text only: no steps to count.
  const steps = processSteps(item.process);
  const time = durationText(item.took);
  const summary = steps > 0 ? t("chat.processLine", { time, count: steps }) : t("chat.processTime", { time });
  return (
    <>
      {line}
      <div className={`bm ${fresh ? "add-anim" : ""}`}>
        <div className="bm-b">
          <div className="bline">
            {children}
            <div className="msg-act">
              <span className="msg-meta">
                <MessageTime at={new Date(item.ts)} />
              </span>
              {copy !== undefined && <CopyButton text={copy} />}
              {item.process.length > 0 && (
                <button className={`tb ${open ? "on" : ""}`} aria-label={t("chat.process")} title={open ? t("chat.processFold") : `${t("chat.process")}：${summary}`} aria-expanded={open} onClick={onProcess}>
                  <Icon name="list" className="sm" />
                </button>
              )}
            </div>
          </div>
          {open && <Process steps={item.process} summary={summary} />}
        </div>
      </div>
    </>
  );
}

/** A message's process: the session page's steps, as one card under the bubble. */
function Process({ steps, summary }: { steps: Step[]; summary: string }) {
  return (
    <div className="tg-b bproc">
      <div className="bproc-h">{summary}</div>
      {steps.map((s) => {
        switch (s.kind) {
          case "work":
            return <Work key={s.key} items={s.items} live={s.live} flat />;
          case "text":
            return (
              <div key={s.key} className="am">
                <Markdown text={s.text} />
              </div>
            );
          case "agents":
            return <AgentCard key={s.key} launches={s.launches} />;
          case "report":
            return <ReportCard key={s.key} step={s} />;
          case "agent_message":
            return <AgentMessageCard key={s.key} step={s} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

/**
 * The last bubble while the bot is busy (bot-mode-design §6.7): three dots; with sub-agents at work,
 * what the bot called the work, and no more. Several show as a count that opens to their names.
 */
function BusyBubble({ busy, retry, onOpen }: { busy: { typing: boolean; agents: WorkingAgent[] }; retry?: { at: number }; onOpen: () => void }) {
  const { t } = useTranslation("bots");
  const now = useNow(1000).getTime();
  const [open, setOpen] = useState(false);
  const agents = busy.agents;
  const dots = (
    <span className="dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
  // Retrying the model for more than ten seconds says so (bot-mode-design §7).
  const unstable = retry && now - retry.at > 10_000;
  const several = agents.length > 1;
  const shown = open && several;
  useLayoutEffect(() => {
    if (shown) onOpen();
    // Only when it opens: a new list of the same length needs nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  return (
    <div className="bm working">
      <div className="bm-b">
        <div className="bline">
          <div className={`bbub wbub ${shown ? "open" : ""}`}>
            {several ? (
              <button className="wb-h" aria-expanded={shown} title={shown ? t("chat.busyClose") : t("chat.busyOpen")} onClick={() => setOpen(!open)}>
                {dots}
                <span className="wb-t">{t("line.agents", { things: thingsText(agents.length) })}</span>
                <Icon name="chevD" className="chev" />
              </button>
            ) : (
              <div className="wb-h" title={agents.length === 0 ? t("line.typing") : undefined}>
                {dots}
                {agents.length === 1 ? <span className="wb-t">{agents[0].label}</span> : unstable && <span className="wb-t">{t("chat.retrying")}</span>}
              </div>
            )}
            {shown && (
              <div className="wb-l">
                {agents.map((a) => (
                  <div key={a.id} className="wb-r">
                    {a.label}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** What the owner had written to each bot and not sent yet. */
const drafts = new Map<string, { text: string; attachments: Attachment[] }>();
/** What failed tasks handed back that is in a composer already. */
const handed = new WeakSet<UserMessage[]>();

/** The composer of a bot's page: only Send (bot-mode-design §6.14); every message goes in as it is sent. */
function BotDock({ bot, view, session, onHeight }: { bot: BotSummary; view: SessionView; session: string; onHeight: (h: number) => void }) {
  const asking = pendingApproval(view);
  const { t } = useTranslation("bots");
  const st = useStore();
  const [draft, setDraft] = useState(() => drafts.get(bot.id) ?? { text: "", attachments: [] });
  const change = (d: { text: string; attachments: Attachment[] }) => {
    setDraft(d);
    drafts.set(bot.id, d);
  };
  // What a failed task handed back goes back to the composer, as on a session's page.
  useEffect(() => {
    const returned = view.returned;
    if (!returned?.length || handed.has(returned)) return;
    handed.add(returned);
    const back = returned.map((m) => fromInput(m.content));
    const d = drafts.get(bot.id) ?? { text: "", attachments: [] };
    change({
      text: [...back.map((b) => b.text), d.text.trim()].filter(Boolean).join("\n\n"),
      attachments: back.reduce<Attachment[]>((list, b) => addAttachments(list, b.attachments), d.attachments),
    });
  }, [view.returned]);
  // Parts of pages from the browser panel, quotes from the document column.
  useComposerInbox(session, (more) => {
    const d = drafts.get(bot.id) ?? { text: "", attachments: [] };
    change({ ...d, attachments: addAttachments(d.attachments, more) });
  });
  const commands = useCommands({ session_id: session });
  const send = async () => {
    const sent = draft;
    change({ text: "", attachments: [] });
    const input = toInput(sent.text, sent.attachments);
    // The PDF the file panel shows goes along, so "this page" means something (document-editor-design §7.4).
    const tab = st.files ? viewingDoc(session) : undefined;
    if (tab && input.length) input.push(docViewingBlock(tab.info.path, tab.info.doc_id, tab.page, tab.info.pages ?? 0));
    // While it answers, a message waits for the step under way and is answered next (bot-design §3.1).
    const ok = await st.op(session, { type: "prompt", input, mode: view.live ? "steer" : undefined });
    if (!ok) change(sent);
  };
  return (
    <Composer
      form={{
        mode: "bot",
        // An approval is no part of the conversation: the session page's prompt, above the composer (bot-mode-design §6.13).
        above: asking
          ? <Approval key={`${asking.agent?.id ?? ""}/${asking.approval.call_id}`} sessionId={session} view={view} />
          : !st.botAccessSeen && view.info.permission_mode === "bypass-permissions" && <FullAccessNote onSettings={() => st.set(OPEN_SETTINGS)} onClose={() => st.set({ botAccessSeen: true })} />,
        onHeight,
      }}
      value={draft.text}
      onChange={(text) => change({ ...draft, text })}
      attachments={draft.attachments}
      onAttachments={(attachments) => change({ ...draft, attachments })}
      onSend={() => void send()}
      commands={commands}
      placeholder={t("chat.placeholder", { name: bot.name })}
    />
  );
}
