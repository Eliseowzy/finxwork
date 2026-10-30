import { useState } from "react";
import { useTranslation } from "react-i18next";
import { projectNames, recentProjects } from "@finx/client";
import { SidebarToggle } from "../components";
import { Mark } from "../icons";
import { useStore } from "../store";
import type { Attachment } from "./attachments";
import { Composer } from "./Composer";
import { onboardingEvent } from "../onboarding/Onboarding";
import { needsKey } from "./KeySetup";
import { useCommands } from "./skills";

const greetings = ["new.greeting1", "new.greeting2", "new.greeting3", "new.greeting4"] as const;

/**
 * A new session: finx's mark and a line in the middle, and the composer in
 * its new-session form at the bottom (it also asks where the session runs
 * and in which project). Sending starts the session and its first task at
 * once; folders attached become more workspace roots of it.
 */
export function NewSession() {
  const { t } = useTranslation("session");
  const st = useStore();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [greeting] = useState(() => greetings[Math.floor(Math.random() * greetings.length)]);
  const recent = recentProjects(st.sessions.filter((s) => !s.archived));
  const cwd = st.draft.cwd ?? recent[0] ?? null;
  const draft = { ...st.draft, cwd };
  const keyless = needsKey(st);
  const commands = useCommands(cwd ? { cwd } : null);
  const set = (patch: Partial<typeof draft>) => st.set({ draft: { ...draft, ...patch } });
  const pick = async () => {
    // A page outside the app has no dialog: the path, typed.
    const dir = window.finx ? await window.finx.pickDirectory() : window.prompt(t("new.pathPrompt"));
    if (dir) set({ cwd: dir });
  };
  return (
    <>
      <div className="ctool drag">
        <SidebarToggle />
        <div className="ctitle" />
      </div>
      <div className="newpage">
        {/* No model can run (the first-run page was left for later): the way back to it. */}
        {keyless ? (
          <div className="new-hero">
            <Mark size={72} />
            <h1>{t("new.noModel")}</h1>
            <button className="btn primary" onClick={() => window.dispatchEvent(new Event(onboardingEvent))}>
              {t("new.connect")}
            </button>
          </div>
        ) : (
          <div className="new-hero">
            <Mark size={72} />
            <h1>{t(greeting)}</h1>
          </div>
        )}
        <Composer
          form={{ mode: "new", place: { cwd, recent, names: projectNames([...recent, ...(cwd ? [cwd] : [])]), onCwd: (p) => set({ cwd: p }), onPick: pick } }}
          value={text}
          onChange={setText}
          attachments={attachments}
          onAttachments={setAttachments}
          canSend={cwd !== null && st.kernel === "ready" && !keyless}
          commands={commands}
          placeholder={keyless ? t("new.connectFirst") : cwd ? t("new.placeholder") : t("new.pickFirst")}
          onSend={async () => {
            const sent = { text, attachments };
            setText("");
            setAttachments([]);
            if (!(await st.start(sent.text, draft, sent.attachments))) (setText(sent.text), setAttachments(sent.attachments));
          }}
          settings={{
            permission: draft.permission,
            onPermission: (m) => set({ permission: m }),
            model: draft.model,
            thinking: draft.thinking,
            models: st.models,
            onModel: (ref) => set({ model: ref }),
            onThinking: (l) => set({ thinking: l }),
          }}
        />
      </div>
    </>
  );
}
