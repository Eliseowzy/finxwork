import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { draftModel, projectNames, recentProjects } from "@finx/client";
import { SidebarToggle } from "../components";
import { draftThinking, offersThinking } from "../format";
import { MarkMotion } from "../icons";
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
 * and in which project, if any). Sending starts the session and its first task at
 * once; folders attached become more workspace roots of it.
 */
export function NewSession() {
  const { t } = useTranslation("session");
  const st = useStore();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [greeting] = useState(() => greetings[Math.floor(Math.random() * greetings.length)]);
  // 自定义 › 在对话中使用 (or 创建) starts the message with the skill.
  useEffect(() => {
    if (st.prefill === null) return;
    setText(st.prefill);
    st.set({ prefill: null });
  }, [st.prefill, st.set]);
  const recent = recentProjects(st.sessions.filter((s) => !s.archived));
  // A project chosen, else the latest one, else none.
  const cwd = st.draft.noProject ? null : (st.draft.cwd ?? recent[0] ?? null);
  // A model chosen here whose connection has gone since: the default, as sending it would fail.
  const draft = { ...st.draft, cwd, noProject: cwd === null, model: draftModel(st.models, st.draft.model) };
  const keyless = needsKey(st);
  const commands = useCommands(cwd ? { cwd } : {});
  const set = (patch: Partial<typeof draft>) => st.set({ draft: { ...draft, ...patch } });
  // The level on the page: chosen here when the model offers it, else the model's own.
  const model = draft.model ?? st.models.defaults?.model ?? "";
  const thinking = draftThinking(st.models.models.find((m) => m.id === model), draft.thinking);
  const pick = async () => {
    // A page outside the app has no dialog: the path, typed.
    const dir = window.finx ? await window.finx.pickDirectory() : window.prompt(t("new.pathPrompt"));
    if (dir) set({ cwd: dir, noProject: false });
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
            <MarkMotion size={72} />
            <h1>{t("new.noModel")}</h1>
            <button className="btn primary" onClick={() => window.dispatchEvent(new Event(onboardingEvent))}>
              {t("new.connect")}
            </button>
          </div>
        ) : (
          <div className="new-hero">
            <MarkMotion size={72} />
            <h1>{t(greeting)}</h1>
          </div>
        )}
        <Composer
          form={{ mode: "new", place: { cwd, recent, names: projectNames([...recent, ...(cwd ? [cwd] : [])]), onCwd: (p) => set({ cwd: p, noProject: p === null }), onPick: pick } }}
          value={text}
          onChange={setText}
          attachments={attachments}
          onAttachments={setAttachments}
          canSend={st.kernel === "ready" && !keyless}
          commands={commands}
          placeholder={keyless ? t("new.connectFirst") : t("new.placeholder")}
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
            thinking,
            models: st.models,
            // As a session switches (§18): the level goes along when the new model offers it, else
            // the one last chosen here for that model, else the model's own.
            onModel: (ref) => {
              const next = st.models.models.find((m) => m.id === ref);
              const remembered = draft.levels?.[ref];
              const kept =
                thinking !== "default" && offersThinking(next, thinking) ? thinking : remembered && offersThinking(next, remembered) ? remembered : null;
              set({ model: ref, thinking: kept });
              return draftThinking(next, kept);
            },
            onThinking: (l) => set({ thinking: l, levels: { ...draft.levels, [model]: l } }),
          }}
        />
      </div>
    </>
  );
}
