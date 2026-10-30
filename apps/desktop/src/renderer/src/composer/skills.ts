import { useEffect, useState } from "react";
import type { CommandInfo } from "@finx/protocol";
import { useStore } from "../store";

/** Commands already asked for: a session's never change (docs/kernel/skill-design.md §6.3.7). */
const known = new Map<string, CommandInfo[]>();

/**
 * What typing `/` offers in the composer: the commands of a session (asked once), or those a
 * new session started in `cwd` would have (asked again when the folder changes).
 */
export function useCommands(source: { session_id: string } | { cwd: string } | null): CommandInfo[] {
  const st = useStore();
  const key = source === null ? "" : "session_id" in source ? `session:${source.session_id}` : `cwd:${source.cwd}`;
  const [commands, setCommands] = useState<CommandInfo[]>(() => known.get(key) ?? []);
  useEffect(() => {
    if (source === null || st.kernel !== "ready") return;
    const kept = known.get(key);
    if (kept) setCommands(kept);
    if (kept && "session_id" in source) return;
    let current = true;
    st.call("skills/list", source)
      .then((result) => {
        const list = result.commands ?? [];
        known.set(key, list);
        if (current) setCommands(list);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
    // `source` is described by `key`.
  }, [key, st.kernel]);
  return commands;
}
