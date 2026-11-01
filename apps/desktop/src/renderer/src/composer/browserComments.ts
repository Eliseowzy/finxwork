import { useEffect, useRef } from "react";
import { webAttachment, type WebAttachment } from "./attachments";

// Parts of pages the person adds from the browser panel go to the composer of the
// conversation the tab belongs to; one whose composer is not on screen waits here for it.

const waiting = new Map<string, WebAttachment[]>();
const composers = new Map<string, (a: WebAttachment[]) => void>();

window.finx?.onBrowserComment(({ session, comment }) => {
  const a = webAttachment(comment);
  const add = composers.get(session);
  if (add) add([a]);
  else waiting.set(session, [...(waiting.get(session) ?? []), a]);
});

/** Takes the session's parts of pages as they come, and those that came while its composer was away. */
export function useBrowserComments(session: string, add: (a: WebAttachment[]) => void) {
  const latest = useRef(add);
  latest.current = add;
  useEffect(() => {
    const take = (a: WebAttachment[]) => latest.current(a);
    composers.set(session, take);
    const early = waiting.get(session);
    if (early) (waiting.delete(session), take(early));
    return () => {
      if (composers.get(session) === take) composers.delete(session);
    };
  }, [session]);
}
