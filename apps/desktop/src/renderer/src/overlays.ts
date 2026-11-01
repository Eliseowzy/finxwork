import { useEffect, useState } from "react";

// What lies over the whole window for now: dialogs, the search palette, the dim while the
// settings window is open. The embedded browser's tab is a view of the main process above
// the page (session/Browser.tsx), so it steps aside while any of these is open, or it would
// show through them.

let open = 0;
const listeners = new Set<(covered: boolean) => void>();

function changed() {
  for (const cb of listeners) cb(open > 0);
}

/** Counts this component as an overlay while it is mounted (and `active`). */
export function useOverlay(active = true) {
  useEffect(() => {
    if (!active) return;
    open++;
    changed();
    return () => {
      open--;
      changed();
    };
  }, [active]);
}

/** Whether an overlay is open, now and as that changes. */
export function useCovered(): boolean {
  const [covered, setCovered] = useState(open > 0);
  useEffect(() => {
    setCovered(open > 0);
    listeners.add(setCovered);
    return () => void listeners.delete(setCovered);
  }, []);
  return covered;
}
