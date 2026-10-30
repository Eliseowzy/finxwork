import { useEffect, useState } from "react";
import { applyEvents, fromSnapshot, type SessionView } from "@finx/client";
import type { Event } from "@finx/protocol";
import { errorText, useStore } from "../store";

/**
 * The conversations opened last, the newest last: going back to one shows
 * it at once, while its attach brings it up to date.
 */
const kept = new Map<string, SessionView>();
const keepAtMost = 10;

/** A session's state as last seen, if its page was open lately (the list's menus use its file). */
export function keptView(id: string): SessionView | undefined {
  return kept.get(id);
}

function keep(id: string, v: SessionView) {
  kept.delete(id);
  kept.set(id, v);
  if (kept.size > keepAtMost) kept.delete(kept.keys().next().value!);
}

/**
 * A session's state while its page shows it (desktop-design §6.2): attached
 * with a snapshot, then every event after it. Events are applied once a
 * frame, however many arrive in it; a detach from finx's side attaches again.
 */
export function useSession(id: string): SessionView | null {
  const st = useStore();
  const { rpc, show } = st;
  const [got, setGot] = useState<{ id: string; view: SessionView | null }>(() => ({ id, view: kept.get(id) ?? null }));

  useEffect(() => {
    if (!rpc) return;
    let stop = false;
    let view: SessionView | null = null;
    let pending: Event[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (!view || pending.length === 0) return;
      view = applyEvents(view, pending);
      pending = [];
      keep(id, view);
      setGot({ id, view });
    };
    const attach = async () => {
      // Loads the session from its log, or attaches when finx has it loaded already.
      const { snapshot } = await rpc.request("session/resume", { session_id: id });
      if (stop) return;
      // Events up to the snapshot are in it already: applyEvents skips them by seq.
      view = applyEvents(fromSnapshot(snapshot), pending);
      pending = [];
      keep(id, view);
      setGot({ id, view });
    };
    const offEvent = rpc.on("session/event", (p) => {
      if (p.session_id !== id) return;
      pending.push(p.event);
      if (!frame) frame = requestAnimationFrame(flush);
    });
    const offDetached = rpc.on("session/detached", (p) => {
      if (p.session_id === id && !stop) attach().catch((e) => show(errorText(e), undefined, true));
    });
    attach().catch((e) => !stop && show(errorText(e), undefined, true));
    return () => {
      stop = true;
      offEvent();
      offDetached();
      cancelAnimationFrame(frame);
      rpc.request("session/detach", { session_id: id }).catch(() => {});
    };
  }, [rpc, id, show]);

  return got.id === id ? got.view : (kept.get(id) ?? null);
}
