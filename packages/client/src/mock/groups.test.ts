import assert from "node:assert/strict";
import { test } from "node:test";
import type { GroupMessage, GroupSummary } from "@finx/protocol";
import { RpcClient } from "../rpc.ts";
import { mockTransport } from "./index.ts";
import { MockServer } from "./server.ts";

function client(server = new MockServer({ still: true })) {
  return new RpcClient(mockTransport(server));
}

test("the demo group has two local bots, another subject's bot, a thread and a quote", async () => {
  const rpc = client();
  await rpc.request("initialize", { protocol_version: 2 });
  const { groups } = await rpc.request("groups/subscribe", {});
  const group = groups.find((g: GroupSummary) => g.id === "demo-group")!;
  assert.equal(group.members.length, 3);
  assert.equal(group.members.filter((m) => m.external).length, 1);
  assert.equal(group.external, true);
  assert.ok(group.last);

  const opened = await rpc.request("groups/open", { id: group.id });
  assert.equal(opened.messages.filter((m: GroupMessage) => m.thread == null).length, 5);
  const threads = opened.threads ?? [];
  assert.equal(threads.length, 1);
  assert.ok(opened.messages.some((m: GroupMessage) => m.reply_preview));

  const thread = await rpc.request("groups/thread", { id: group.id, root: threads[0]!.root });
  assert.equal(thread.messages.length, 2);
});

test("sending appends a message and pushes it", async () => {
  const server = new MockServer({ still: true });
  const rpc = client(server);
  await rpc.request("initialize", { protocol_version: 2 });
  const { groups } = await rpc.request("groups/subscribe", {});
  const group = groups.find((g: GroupSummary) => g.id === "demo-group")!;
  const pushed = new Promise<{ group_id: string; message: GroupMessage }>((resolve) => rpc.on("group/message", resolve));
  const { message } = await rpc.request("groups/send", { id: group.id, text: "@研究员 再看一眼" });
  assert.equal(message.seq, 6);
  assert.deepEqual(message.mentions, [group.members.find((m) => m.name === "研究员")!.bot_id]);
  assert.equal((await pushed).message.id, message.id);
  const opened = await rpc.request("groups/open", { id: group.id });
  assert.equal(opened.messages.at(-1)!.text, "@研究员 再看一眼");
});

test("creating, adding and removing members changes the list", async () => {
  const rpc = client();
  await rpc.request("initialize", { protocol_version: 2 });
  const { groups } = await rpc.request("groups/subscribe", {});
  const finx = groups[0].members[0];
  const created: GroupSummary = await rpc.request("groups/create", {
    name: "新的群",
    note: "说明",
    members: [{ bot_id: finx.bot_id, mode: "lazy" }],
  });
  assert.equal(created.members[0].mode, "lazy");
  const added: GroupSummary = await rpc.request("groups/add_member", { id: created.id, bot_id: "bot-2" });
  assert.equal(added.members.length, 2);
  await rpc.request("groups/set_member", { id: created.id, bot_id: "bot-2", mode: "mentions" });
  const opened = await rpc.request("groups/open", { id: created.id });
  assert.equal(opened.group.members[1].mode, "mentions");
  await rpc.request("groups/remove_member", { id: created.id, bot_id: "bot-2" });
  await rpc.request("groups/delete", { id: created.id });
  const after = await rpc.request("groups/subscribe", {});
  assert.ok(!after.groups.some((g: GroupSummary) => g.id === created.id));
});
