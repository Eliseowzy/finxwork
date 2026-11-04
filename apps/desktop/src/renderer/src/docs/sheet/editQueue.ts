import { useRef, useState } from "react";
import type { DocInfo } from "@finx/protocol";
import { setDocInfo } from "../state";

// Edits, undo and recalc of a workbook run one after another, never dropped: what is typed while
// one is on its way waits for it, and goes against the revision it made.

export type EditQueue = {
  busy: boolean;
  /** Runs `task` after everything queued before it. */
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
  /** Everything queued so far, done (saving waits for it). */
  idle: () => Promise<unknown>;
  /** A revision this view made: the document's info takes it at once, for the next edit in the queue. */
  made: (r: { revision: number; dirty: boolean }) => void;
  /** The revision the next edit goes against. */
  revision: () => number;
  /** Whether `revision` was made here (and forgets those up to it): anything else is the agent's. */
  takeOwn: (revision: number) => boolean;
};

export function useEditQueue(session: string, info: DocInfo): EditQueue {
  const [busy, setBusy] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const revision = useRef(info.revision);
  const own = useRef(new Set<number>());
  const latest = useRef(info);
  latest.current = info;
  if (pending.current === 0) revision.current = info.revision;
  return {
    busy,
    enqueue: (task) => {
      pending.current++;
      setBusy(true);
      const run = queue.current.then(task).finally(() => {
        if (--pending.current === 0) setBusy(false);
      });
      queue.current = run.catch(() => {});
      return run;
    },
    idle: () => queue.current,
    made: (r) => {
      revision.current = r.revision;
      own.current.add(r.revision);
      setDocInfo(session, { ...latest.current, revision: r.revision, dirty: r.dirty });
    },
    revision: () => revision.current,
    takeOwn: (r) => {
      const mine = own.current.has(r);
      for (const x of own.current) if (x <= r) own.current.delete(x);
      return mine;
    },
  };
}
