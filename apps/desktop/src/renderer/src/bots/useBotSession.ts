import { useCallback, useEffect, useRef, useState } from "react";
import { applyEvents, fromSnapshot, withHistory, type SessionView } from "@finx/client";
import type { Event } from "@finx/protocol";
import { errorText, useStore } from "../store";

/** What a bot's page never shows: the words as they are written (bot-design §3.5). */
const notStreamed = { exclude: ["text_delta", "thinking_delta", "tool_call_delta", "tool_progress"] as ("text_delta" | "thinking_delta" | "tool_call_delta" | "tool_progress")[] };

/** The bots opened last, the newest last: going back to one shows it at once, while it attaches again. */
const kept = new Map<string, { session: string; view: SessionView }>();

function keep(bot: string, session: string, view: SessionView) {
  kept.delete(bot);
  kept.set(bot, { session, view });
  if (kept.size > 10) kept.delete(kept.keys().next().value!);
}

/**
 * A bot's conversation while its page shows it: attached with `bots/open`
 * (which starts it when there is none), then every event after it, applied
 * once a frame. Earlier history comes a page at a time when asked for. A
 * cleared conversation is a new session: the page attaches to that one.
 */
export function useBotSession(bot: string, session: string | undefined): [SessionView | null, string | null, () => Promise<void>] {
  const st = useStore();
  const { rpc, show } = st;
  const [got, setGot] = useState<{ bot: string; session: string | null; view: SessionView | null }>(() => ({ bot, session: kept.get(bot)?.session ?? null, view: kept.get(bot)?.view ?? null }));
  const earlier = useRef<() => Promise<void>>(async () => {});
  // A conversation cleared, or started elsewhere, is another session: attach again.
  const [generation, setGeneration] = useState(0);
  const attached = got.bot === bot ? got.session : null;
  useEffect(() => {
    if (session && attached && session !== attached) setGeneration((g) => g + 1);
  }, [session]);

  useEffect(() => {
    if (!rpc) return;
    let stop = false;
    let id: string | null = null;
    let view: SessionView | null = null;
    let pending: Event[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (!view || !id || pending.length === 0) return;
      view = applyEvents(view, pending);
      pending = [];
      keep(bot, id, view);
      setGot({ bot, session: id, view });
    };
    const attach = async () => {
      const r = await rpc.request("bots/open", { bot_id: bot, events: notStreamed });
      if (stop) return;
      id = r.session_id;
      // Events up to the snapshot are in it already: applyEvents skips them by seq.
      view = applyEvents(fromSnapshot(r.snapshot), pending);
      pending = [];
      keep(bot, id, view);
      setGot({ bot, session: id, view });
    };
    let paging: Promise<void> | null = null;
    earlier.current = () => {
      const cursor = view?.before;
      if (!cursor || !id) return Promise.resolve();
      paging ??= rpc
        .request("session/history", { session_id: id, before: cursor })
        .then((page) => {
          if (stop || !view || !id || view.before !== cursor) return;
          view = withHistory(view, page);
          keep(bot, id, view);
          setGot({ bot, session: id, view });
        })
        .catch((e) => {
          if (!stop) show(errorText(e), undefined, true);
        })
        .finally(() => (paging = null));
      return paging;
    };
    const offEvent = rpc.on("session/event", (p) => {
      // Before the snapshot names the session, events are of no session known yet.
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
      earlier.current = async () => {};
      offEvent();
      offDetached();
      cancelAnimationFrame(frame);
      if (id) rpc.request("session/detach", { session_id: id }).catch(() => {});
    };
  }, [rpc, bot, generation, show]);

  const loadEarlier = useCallback(() => earlier.current(), []);
  const fresh = got.bot === bot;
  return [fresh ? got.view : (kept.get(bot)?.view ?? null), fresh ? got.session : (kept.get(bot)?.session ?? null), loadEarlier];
}
