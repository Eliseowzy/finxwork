import { RpcError } from "@finx/client";

/** An error finx gave for a reason the caller handles: `doc_password`, `doc_conflict`… */
export const isRpcKind = (e: unknown, kind: string): e is RpcError => e instanceof RpcError && e.kind === kind;
