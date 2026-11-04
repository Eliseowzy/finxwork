import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionDiagnostic, rpcConnectionDiagnostic } from "./connection-diagnostic.ts";
import type { ConnectionDiagnostic, ConnectionView } from "@finx/protocol";
const diagnostic: ConnectionDiagnostic = {
  stage: "authorization", code: "permission_denied", message: "Access denied", action: "check_account",
  retryable: false, http_status: 403, checked_at: "2026-11-03T10:00:00Z",
};
const connection: ConnectionView = {
  connection_id: "c", provider_id: "p", adapter_id: "qwenwork", display_name: "QwenWork",
  state: "unavailable", models: [], diagnostic,
};
test("structured RPC diagnostics survive pre-connection failure and strip unknown fields", () => {
  const parsed = rpcConnectionDiagnostic({ data: { diagnostic: { ...diagnostic, token: "secret" } } });
  assert.equal(parsed?.http_status, 403);
  assert.equal(parsed?.action, "check_account");
  assert.ok(!JSON.stringify(parsed).includes("secret"));
  assert.equal(connectionDiagnostic(null, parsed)?.code, "permission_denied");
  assert.equal(rpcConnectionDiagnostic(new Error("old kernel")), null);
  assert.equal(rpcConnectionDiagnostic({ data: { diagnostic: { code: "broken" } } }), null);
});
test("reopened settings uses snapshot diagnostics; newer failures take precedence", () => {
  assert.equal(connectionDiagnostic(connection, null)?.code, "permission_denied");
  assert.equal(connectionDiagnostic(connection, { ...diagnostic, code: "old", checked_at: "2026-11-02T10:00:00Z" })?.code, "permission_denied");
  assert.equal(connectionDiagnostic(connection, { ...diagnostic, code: "new", checked_at: "2026-11-04T10:00:00Z" })?.code, "new");
  assert.equal(connectionDiagnostic({ ...connection, state: "ready", diagnostic: null }, null), null);
});
