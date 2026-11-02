import type { PermissionMode, ErrorInfo, SiteGrant, ToolCategory } from "@finx/protocol";

// What a scripted task does, turn by turn: the mock server plays it as finx
// would, event by event.

export interface ToolScript {
  name: string;
  args: Record<string, unknown>;
  /** The result's text (what the model would be sent). */
  output: string;
  error?: boolean;
  /** Printed while it runs, line by line. */
  progress?: string[];
  /** How long it runs (ms, before the speed factor). */
  ms?: number;
  /** Asks for approval in the approval modes that ask for this kind of call; a website on
   * the user's own Chrome (`own_chrome`) asks in every mode, offering its `grants`. */
  approval?: { summary: string; reason?: string; grants?: SiteGrant[]; own_chrome?: boolean };
}

export interface TurnScript {
  think?: string;
  say?: string;
  tools?: ToolScript[];
}

export interface TaskScript {
  turns: TurnScript[];
  /** The task fails after its turns, with this error. */
  fail?: ErrorInfo;
  /** Before its first turn the model request fails this many times and is retried, as finx retries a rate limit. */
  retries?: { count: number; error: ErrorInfo };
}

/** Whether a call with an approval in its script asks in this mode. */
export function asks(mode: PermissionMode, category: ToolCategory): boolean {
  if (mode === "bypass-permissions") return false;
  if (mode === "accept-edits") return category !== "edit";
  return true;
}
