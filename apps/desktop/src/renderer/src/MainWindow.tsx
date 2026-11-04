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
import { useStore } from "./store";
import { BotPage } from "./bots/BotPage";
import { BotSheet } from "./bots/BotSheet";

export function MainWindow() {
  const st = useStore();
  useCommands();
  useYoursWatcher();
  const sel = st.selection;
  const session = sel.kind === "session" ? st.sessions.find((s) => s.session_id === sel.id) : undefined;
  // A selected session that is gone (deleted elsewhere): back to a new one. Gone only once the
  // list has had it: a session just started is selected before finx's push brings it to the
  // list. The selection the window opens with is checked against the list's first arrival.
  const listed = useRef(sel.kind === "session" ? sel.id : null);
  useEffect(() => {
    if (sel.kind !== "session") return;
    if (session) listed.current = sel.id;
    else if (st.loaded && listed.current === sel.id) st.set({ selection: { kind: "new" } });
  }, [sel, st.loaded, session, st.set]);
  // Bot mode shows a bot: the one chosen last, else the first; one deleted makes way for the first.
  const bot = sel.kind === "bot" ? st.bots.find((b) => b.id === sel.id) : undefined;
  useEffect(() => {
    if (st.mode !== "bots" || !st.botsLoaded || sel.kind === "customize" || bot) return;
    const next = st.bots.find((b) => b.id === st.lastBot) ?? st.bots[0];
    if (next) st.selectBot(next.id);
  }, [st.mode, st.botsLoaded, sel, bot, st.bots]);
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
      {/* Over the conversation, the sidebar goes again with a click beside it. */}
      {sidebar === "over" && <div className="peek-scrim" onClick={() => setSidebar(st, false)} />}
      {/* The toast sits in the content, under its title bar: never over the composer at the bottom. */}
      <section className="content">
        {sel.kind === "customize" ? (
          <Customize />
        ) : st.mode === "bots" ? (
          bot ? <BotPage key={bot.id} bot={bot} /> : <div className="empty"><span className="mini-spin" /></div>
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
  useEffect(() => {
    if (decided.current || !st.loaded || st.models.models.length === 0) return;
    decided.current = true;
    if (keyless) setOpen(true);
  }, [st.loaded, st.models.models.length, keyless]);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(onboardingEvent, show);
    return () => window.removeEventListener(onboardingEvent, show);
  }, []);
  return { open, close: () => setOpen(false) };
}
