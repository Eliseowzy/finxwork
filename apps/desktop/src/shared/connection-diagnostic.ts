import type { ConnectionDiagnostic, ConnectionView } from "@finx/protocol";

/** Accept structured diagnostics from RPC errors without depending on an Error subclass. */
export function rpcConnectionDiagnostic(error: unknown): ConnectionDiagnostic | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = error.data;
  if (!data || typeof data !== "object" || !("diagnostic" in data)) return null;
  const d = data.diagnostic;
  if (!d || typeof d !== "object") return null;
  const v = d as Record<string, unknown>;
  if (!["stage", "code", "message", "action", "checked_at"].every(k => typeof v[k] === "string") || typeof v.retryable !== "boolean") return null;
  return {
    stage: v.stage as string, code: v.code as string, message: v.message as string,
    action: v.action as string, checked_at: v.checked_at as string, retryable: v.retryable,
    http_status: typeof v.http_status === "number" ? v.http_status : undefined,
    field: typeof v.field === "string" ? v.field : undefined,
  };
}

/** The snapshot survives closing/reopening settings; an RPC error covers pre-connection failures. */
export function connectionDiagnostic(connection: ConnectionView | null, operation: ConnectionDiagnostic | null): ConnectionDiagnostic | null {
  const current = connection?.diagnostic;
  if (!current) return operation;
  if (!operation) return current;
  return current.checked_at >= operation.checked_at ? current : operation;
}
