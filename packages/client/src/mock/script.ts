import type { PermissionMode, ErrorInfo, ToolCategory } from "@finx/protocol";

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
  /** Asks for approval in the approval modes that ask for this kind of call. */
  approval?: { summary: string; reason?: string };
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
}

/** Whether a call with an approval in its script asks in this mode. */
export function asks(mode: PermissionMode, category: ToolCategory): boolean {
  if (mode === "bypass-permissions") return false;
  if (mode === "accept-edits") return category !== "edit";
  return true;
}
