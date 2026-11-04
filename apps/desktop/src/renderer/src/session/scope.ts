import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { PathInfo } from "../../../shared/bridge";

/** The session a reply belongs to: its folder resolves the paths it writes, its browser opens its links. None outside a session. */
export type Scope = { session: string; cwd: string } | null;
const ScopeContext = createContext<Scope>(null);
export const ContentScope = ScopeContext.Provider;
export const useScope = () => useContext(ScopeContext);

/** Inside the block a reply is still writing: nothing in it acts yet (§3.5). */
export const DraftContext = createContext(false);

// ── what the paths a reply writes are: asked of the main process in batches, kept, asked again
// when a task ends or the window comes back (§3.6) ──

type Entry = { info: PathInfo | undefined; listeners: Set<() => void> };
const entries = new Map<string, Entry>();
const waiting = new Map<string, Set<string>>();
let flushing = false;
const keyOf = (base: string, raw: string) => `${base}\0${raw}`;

function want(base: string, raw: string) {
  let raws = waiting.get(base);
  if (!raws) waiting.set(base, (raws = new Set()));
  raws.add(raw);
  if (flushing) return;
  flushing = true;
  setTimeout(() => void flush());
}

async function flush() {
  flushing = false;
  const finx = window.finx;
  const batch = [...waiting];
  waiting.clear();
  if (!finx) return;
  for (const [base, raws] of batch) {
    const list = [...raws];
    for (let i = 0; i < list.length; i += 200) {
      const part = list.slice(i, i + 200);
      const found = await finx.pathInfo(base, part).catch(() => null);
      if (!found) continue;
      part.forEach((raw, j) => {
        const e = entries.get(keyOf(base, raw));
        const next = found[j];
        if (!e || !next || (e.info && e.info.path === next.path && e.info.kind === next.kind && e.info.rel === next.rel)) return;
        e.info = next;
        e.listeners.forEach((f) => f());
      });
    }
  }
}

/** Looks again at every path on screen: the agent may have made or removed files. */
export function recheckFiles() {
  for (const [k, e] of entries) {
    if (e.listeners.size === 0) continue;
    const [base, raw] = k.split("\0");
    want(base, raw);
  }
}
window.addEventListener("focus", recheckFiles);

/** What `raw`, written in a reply, is under `base`; undefined until known. */
export function useFileInfo(base: string, raw: string): PathInfo | undefined {
  const k = keyOf(base, raw);
  const subscribe = useCallback(
    (changed: () => void) => {
      let e = entries.get(k);
      if (!e) {
        entries.set(k, (e = { info: undefined, listeners: new Set() }));
        want(base, raw);
      }
      e.listeners.add(changed);
      return () => void e.listeners.delete(changed);
    },
    [k],
  );
  return useSyncExternalStore(subscribe, () => entries.get(k)?.info);
}
