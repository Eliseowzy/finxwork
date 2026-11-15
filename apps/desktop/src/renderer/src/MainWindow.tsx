import { PageMenuHost } from "./pageMenu";
import { useEffect, useRef, useState } from "react";
import { useCommands } from "./commands";
import { SheetHost, ToastView } from "./components";
import { KeySheet, needsKey } from "./composer/KeySetup";
import { NewSession } from "./composer/NewSession";
import { Customize } from "./customize/Customize";
import { Onboarding, onboardingEvent } from "./onboarding/Onboarding";
import { layoutOf, setSidebar, usePeekEnd } from "./layout";
import { SearchPalette } from "./search/Search";
import { SessionPage } from "./session/SessionPage";
import { useYoursWatcher } from "./session/Yours";
import { Sidebar } from "./sidebar/Sidebar";
import { useOverlay } from "./overlays";
import { useLists, useStore } from "./store";
import { BotPage } from "./bots/BotPage";
import { BotSheet } from "./bots/BotSheet";
import { GroupPage } from "./groups/GroupPage";
import { GroupSheet } from "./groups/GroupSheet";

/** A clicked system notification opens what it is about, in its mode. The page may have just started for it. */
function useOpenTarget() {
  const { setMode, select, selectBot } = useStore();
  useEffect(() => {
    const take = async () => {
      const target = await window.finx?.takeOpenTarget();
      if (!target) return;
      setMode(target.kind === "bot" ? "bots" : "sessions");
      if (target.kind === "bot") selectBot(target.id);
      else select(target.id);
    };
    void take();
    return window.finx?.onOpenTarget(() => void take());
  }, [setMode, select, selectBot]);
}

export function MainWindow() {
  const st = useStore();
  useCommands();
  useYoursWatcher();
  useOpenTarget();
  const sel = st.selection;
  // Only the selected session's and bot's rows: a change to any other leaves the window as it is.
  const session = useLists((l) => (sel.kind === "session" ? l.sessions.find((s) => s.session_id === sel.id) : undefined));
  const loaded = useLists((l) => l.loaded);
  // A selected session that is gone (deleted elsewhere): back to a new one. Gone only once the
  // list has had it: a session just started is selected before finx's push brings it to the
  // list. The selection the window opens with is checked against the list's first arrival.
  const listed = useRef(sel.kind === "session" ? sel.id : null);
  useEffect(() => {
    if (sel.kind !== "session") return;
    if (session) listed.current = sel.id;
    else if (loaded && listed.current === sel.id) st.set({ selection: { kind: "new" } });
  }, [sel, loaded, session, st.set]);
  // Bot mode shows a bot: the one chosen last, else the first; one deleted makes way for the first.
  const bot = useLists((l) => (sel.kind === "bot" ? l.bots.find((b) => b.id === sel.id) : undefined));
  const botsLoaded = useLists((l) => l.botsLoaded);
  const next = useLists((l) => (l.bots.find((b) => b.id === st.lastBot) ?? l.bots[0])?.id);
  // A group shows in the same place (bot-group-chat-dev-brief §5); one deleted makes way for a bot.
  const group = useLists((l) => (sel.kind === "group" ? l.groups.find((g) => g.id === sel.id) : undefined));
  const groupsLoaded = useLists((l) => l.groupsLoaded);
  useEffect(() => {
    if (st.mode !== "bots" || !botsLoaded || sel.kind === "customize" || sel.kind === "group" || bot) return;
    if (next) st.selectBot(next);
  }, [st.mode, botsLoaded, sel, bot, next]);
  useEffect(() => {
    if (st.mode !== "bots" || !groupsLoaded || sel.kind !== "group" || group) return;
    st.set({ selection: { kind: "new" }, groupThread: null, groupPanel: false });
  }, [st.mode, groupsLoaded, sel, group]);
  // A peek ends when it fits again, when another session or page is chosen, and with Esc.
  usePeekEnd(st);
  useEffect(() => {
    st.set({ peek: null });
  }, [sel, st.set]);
  const peeking = st.peek !== null;
  useEffect(() => {
    if (!peeking) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && st.set({ peek: null });
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [peeking, st.set]);
  const settingsOpen = useSettingsOpen();
  useOverlay(settingsOpen);
  const onboarding = useOnboarding();
  if (onboarding.open) return <Onboarding onDone={onboarding.close} />;
  const { sidebar, narrow } = layoutOf(st);
  return (
    <div className={`mainwrap ${sidebar === "docked" ? "" : "noside"} ${sidebar === "over" ? "peek" : ""} ${narrow ? "narrow" : ""}`}>
      <Sidebar />
      <PageMenuHost />
      {/* Over the conversation, the sidebar goes again with a click beside it. */}
      {sidebar === "over" && <div className="peek-scrim" onClick={() => setSidebar(st, false)} />}
      {/* The toast sits in the content, under its title bar: never over the composer at the bottom. */}
      <section className="content">
        {sel.kind === "customize" ? (
          <Customize />
        ) : st.mode === "bots" ? (
          group ? <GroupPage key={group.id} group={group} /> : bot ? <BotPage key={bot.id} bot={bot} /> : <div className="empty"><span className="mini-spin" /></div>
        ) : session ? (
          <SessionPage key={session.session_id} s={session} />
        ) : (
          <NewSession />
        )}
        <ToastView />
      </section>
      {st.searching && <SearchPalette />}
      {/* While the settings window is open the window dims behind it, as under a dialog. Coming back here closes the settings
          (the main process does), and the click that did it lands on the dim, not on what is under it. */}
      {settingsOpen && <div className="settings-dim" />}
      <SheetHost />
      {st.botSheet && <BotSheet />}
      {st.groupSheet && <GroupSheet />}
      <KeySheet />
    </div>
  );
}

/** Whether the settings window is open, now and as that changes. */
function useSettingsOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void window.finx?.settingsOpen().then(setOpen);
    return window.finx?.onSettingsOpen(setOpen);
  }, []);
  return open;
}

/**
 * The first-run page: decided once, when the models first arrive (no model can
 * run: it opens), and opened again by `onboardingEvent`. It stays until the
 * person leaves it, so a model connected on it shows "ready" first.
 * A page previewed in a browser opens it with #onboarding.
 */
function useOnboarding() {
  const st = useStore();
  const [open, setOpen] = useState(location.hash === "#onboarding");
  const decided = useRef(false);
  const keyless = needsKey(st);
  const loaded = useLists((l) => l.loaded);
  useEffect(() => {
    if (decided.current || !loaded || st.models.providers.length === 0) return;
    decided.current = true;
    if (keyless) setOpen(true);
  }, [loaded, st.models.providers.length, keyless]);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(onboardingEvent, show);
    return () => window.removeEventListener(onboardingEvent, show);
  }, []);
  return { open, close: () => setOpen(false) };
}
