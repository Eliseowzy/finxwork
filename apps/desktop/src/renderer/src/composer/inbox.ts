import { useEffect, useRef } from "react";
import { webAttachment, type Attachment } from "./attachments";

// What the person adds to a conversation from beside it — a part of a web page from the
// browser panel, a part of a document from the document column — goes to that conversation's
// composer; for one whose composer is not on screen, it waits here.

const waiting = new Map<string, Attachment[]>();
const composers = new Map<string, (a: Attachment[]) => void>();

/** Puts attachments in the session's composer, or keeps them until the composer is on screen. */
export function toComposer(session: string, more: Attachment[]) {
  const add = composers.get(session);
  if (add) add(more);
  else waiting.set(session, [...(waiting.get(session) ?? []), ...more]);
}

window.finx?.onBrowserComment(({ session, comment, image }) => toComposer(session, [webAttachment(comment, image)]));

/** Takes what comes for the session, and what came while its composer was away. */
export function useComposerInbox(session: string, add: (a: Attachment[]) => void) {
  const latest = useRef(add);
  latest.current = add;
  useEffect(() => {
    const take = (a: Attachment[]) => latest.current(a);
    composers.set(session, take);
    const early = waiting.get(session);
    if (early) (waiting.delete(session), take(early));
    return () => {
      if (composers.get(session) === take) composers.delete(session);
    };
  }, [session]);
}
