import assert from "node:assert/strict";
import { test } from "node:test";
import type { RpcClient } from "@finx/client";
import type { PptxReadProgress } from "@finx/protocol";
import { readPresentation } from "./progress.ts";

test("concurrent opens isolate progress and remove their listeners when complete or failed", async () => {
  const listeners = new Set<(event: PptxReadProgress) => void>();
  const requests: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const rpc = {
    on(method: string, cb: (event: PptxReadProgress) => void) {
      assert.equal(method, "pptx/readProgress");
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    request(method: string, params: { progress_id: string }) {
      assert.equal(method, "pptx/read");
      assert.equal(listeners.size, requests.length + 1, "subscribed before the request");
      return new Promise((resolve, reject) => requests.push({ id: params.progress_id, resolve, reject }));
    },
  } as unknown as RpcClient;
  const seen: number[][] = [[], []];
  const a = readPresentation(rpc, "session", "same.pptx", (p) => seen[0].push(p.completed));
  const b = readPresentation(rpc, "session", "same.pptx", (p) => seen[1].push(p.completed));
  assert.notEqual(requests[0].id, requests[1].id);
  for (const cb of listeners) {
    cb({ session_id: "other", progress_id: requests[0].id, stage: "reading", completed: 99, total: 100 });
    cb({ session_id: "session", progress_id: requests[0].id, stage: "reading", completed: 10, total: 100 });
    cb({ session_id: "session", progress_id: requests[1].id, stage: "inspecting", completed: 20, total: 100 });
  }
  assert.deepEqual(seen, [[0, 10], [0, 20]]);
  requests[0].resolve({ hash: "done" });
  assert.deepEqual(await a, { hash: "done" });
  assert.equal(listeners.size, 1);
  const rejected = assert.rejects(b, /disconnected/);
  requests[1].reject(new Error("disconnected"));
  await rejected;
  assert.equal(listeners.size, 0);
});
