import { useCallback, useEffect, useRef, useState } from "react";
import { applyEvents, fromSnapshot, latestPage, withHistory, type SessionView } from "@finx/client";
import type { Event } from "@finx/protocol";
import { errorText, useStore } from "../store";

/**
 * The conversations opened last, the newest last: going back to one shows
 * it at once, while its attach brings it up to date.
 */
const kept = new Map<string, SessionView>();
const keepAtMost = 10;
/** finx's first page of a session: a kept one needs no more, since its attach brings only that back. */
const keptEntries = 100;

/** A session's state as last seen, if its page was open lately (the list's menus use its file). */
export function keptView(id: string): SessionView | undefined {
  return kept.get(id);
}

function keep(id: string, v: SessionView) {
  kept.delete(id);
  kept.set(id, latestPage(v, keptEntries));
  if (kept.size > keepAtMost) kept.delete(kept.keys().next().value!);
}

const flowEvery = 30;
const flows = (e: Event): boolean => e.type === "message_delta" || e.type === "tool_progress" || (e.type === "agent_event" && flows(e.event));

/**
 * A session's state while its page shows it (desktop-design §6.2): attached
 * with a snapshot, then every event after it. Events are applied once a
 * frame, however many arrive in it; what only adds to text at most every
 * `flowEvery` ms (the page need not be worked out for each piece a model
 * sends; words do not read faster than that). Anything else goes in the next
 * frame, and takes what waits with it. A detach from finx's side attaches again.
 * Earlier history comes a page at a time when asked for.
 */
export function useSession(id: string): [SessionView | null, () => Promise<void>] {
  const st = useStore();
  const { rpc, show } = st;
  const [got, setGot] = useState<{ id: string; view: SessionView | null }>(() => ({ id, view: kept.get(id) ?? null }));
  const earlier = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!rpc) return;
    let stop = false;
    let view: SessionView | null = null;
    let pending: Event[] = [];
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flushed = 0;
    const flush = () => {
      frame = 0;
      clearTimeout(timer);
      timer = undefined;
      flushed = performance.now();
      if (!view || pending.length === 0) return;
      view = applyEvents(view, pending);
      pending = [];
      keep(id, view);
      setGot({ id, view });
      // It went back past all this view holds: a new snapshot says what is left.
      if (view.stale && !renewing) {
        renewing = true;
        attach()
          .catch((e) => !stop && show(errorText(e), undefined, true))
          .finally(() => (renewing = false));
      }
    };
    let renewing = false;
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
    let paging: Promise<void> | null = null;
    earlier.current = () => {
      const cursor = view?.before;
      if (!cursor) return Promise.resolve();
      paging ??= rpc
        .request("session/history", { session_id: id, before: cursor })
        .then((page) => {
          // A fresh snapshot since (finx detached and attached again) has its own cursor.
          if (stop || !view || view.before !== cursor) return;
          view = withHistory(view, page);
          keep(id, view);
          setGot({ id, view });
        })
        .catch((e) => {
          if (!stop) show(errorText(e), undefined, true);
        })
        .finally(() => (paging = null));
      return paging;
    };
    const offEvent = rpc.on("session/event", (p) => {
      if (p.session_id !== id) return;
      pending.push(p.event);
      if (frame) return;
      if (!flows(p.event)) frame = requestAnimationFrame(flush);
      else timer ??= setTimeout(() => {
        timer = undefined;
        frame ||= requestAnimationFrame(flush);
      }, Math.max(0, flushed + flowEvery - performance.now()));
    });
    const offDetached = rpc.on("session/detached", (p) => {
      if (p.session_id === id && !stop) attach().catch((e) => show(errorText(e), undefined, true));
    });
    attach().catch((e) => !stop && show(errorText(e), undefined, true));
    return () => {
      stop = true;
      earlier.current = async () => {};
      offEvent();
      offDetached();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      rpc.request("session/detach", { session_id: id }).catch(() => {});
    };
  }, [rpc, id, show]);

  const loadEarlier = useCallback(() => earlier.current(), []);
  return [got.id === id ? got.view : (kept.get(id) ?? null), loadEarlier];
}
