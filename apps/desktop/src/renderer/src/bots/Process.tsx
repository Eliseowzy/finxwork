import type { Step } from "@finx/client";
import { Markdown } from "../session/Markdown";
import { Work } from "../session/Steps";

/** A routine's run on its way to its end: the session page's steps, as one card. */
export function Process({ steps }: { steps: Step[] }) {
  return (
    <div className="tg-b bproc">
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
          default:
            return null;
        }
      })}
    </div>
  );
}
