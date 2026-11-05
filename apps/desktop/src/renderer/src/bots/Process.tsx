import { useTranslation } from "react-i18next";
import type { Step } from "@finx/client";
import { momentText } from "../format";
import { Icon } from "../icons";
import { AgentCard, ReportCard } from "../session/Agents";
import { Markdown } from "../session/Markdown";
import { Work } from "../session/Steps";
import { useNow, useStore } from "../store";

/** What a bot did on the way to a message, or a routine's run on its way to its end: the session page's steps, as one card. */
export function Process({ steps, summary }: { steps: Step[]; summary?: string }) {
  return (
    <div className="tg-b bproc">
      {summary && <div className="bproc-h">{summary}</div>}
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
            return s.routine ? <RoutineStep key={s.key} step={s} /> : <ReportCard key={s.key} step={s} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

/** The run a message passes on, which opens in the routines panel (bot-mode-design §6.21). */
function RoutineStep({ step }: { step: Extract<Step, { kind: "report" }> }) {
  const { t } = useTranslation("bots");
  const st = useStore();
  const now = useNow(60_000);
  return (
    <button
      className="rtn-line rtn-step"
      onClick={() => st.set({ botRoutines: { routine: step.routine?.id, run: step.routine?.run }, botPanel: false, files: false, filesMax: false, browser: false, browserMax: false })}
    >
      <Icon name="clock" />
      {t("routines.fromRun", { name: step.name, time: momentText(new Date(step.ts), now) })}
    </button>
  );
}
