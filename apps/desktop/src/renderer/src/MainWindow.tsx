import { useEffect, useRef, useState } from "react";
import { useCommands } from "./commands";
import { SheetHost, ToastView } from "./components";
import { KeySheet, needsKey } from "./composer/KeySetup";
import { NewSession } from "./composer/NewSession";
import { Onboarding, onboardingEvent } from "./onboarding/Onboarding";
import { SearchPalette } from "./search/Search";
import { SessionPage } from "./session/SessionPage";
import { Sidebar } from "./sidebar/Sidebar";
import { useStore } from "./store";

export function MainWindow() {
  const st = useStore();
  useCommands();
  const sel = st.selection;
  const session = sel.kind === "session" ? st.sessions.find((s) => s.session_id === sel.id) : undefined;
  // A selected session that is gone (deleted elsewhere): back to a new one.
  useEffect(() => {
    if (sel.kind === "session" && st.loaded && !session) st.set({ selection: { kind: "new" } });
  }, [sel, st.loaded, session, st.set]);
  const onboarding = useOnboarding();
  if (onboarding.open) return <Onboarding onDone={onboarding.close} />;
  return (
    <div className={`mainwrap ${st.sidebar ? "" : "noside"}`}>
      <Sidebar />
      {/* The toast sits in the content, under its title bar: never over the composer at the bottom. */}
      <section className="content">
        {session ? <SessionPage key={session.session_id} s={session} /> : <NewSession />}
        <ToastView />
      </section>
      {st.searching && <SearchPalette />}
      <SheetHost />
      <KeySheet />
    </div>
  );
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
