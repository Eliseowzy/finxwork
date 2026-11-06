import assert from "node:assert/strict";
import { test } from "node:test";
import { EmbeddedBrowser, type Download, type PageEvents, type PageHost } from "./shim.ts";

type Sent = { method: string; params: object; session?: string };

/** Pages that answer every command with its name, and remember what they got. */
function fakeHost() {
  const pages = new Map<string, { events: PageEvents; sent: Sent[]; closed: boolean; url: string; byPerson?: boolean }>();
  const activated: string[] = [];
  let report: ((d: Download) => void) | null = null;
  const host: PageHost = {
    create({ targetId, url, openerId, byPerson }, events) {
      const page = { events, sent: [] as Sent[], closed: false, url, openerId, byPerson };
      pages.set(targetId, page);
      return {
        send: async (method, params, session) => (page.sent.push({ method, params, session }), { echo: method }),
        url: () => page.url,
        title: () => "T",
        close: () => (page.closed = true),
      };
    },
    activate: (id) => void activated.push(id),
    downloads: (_dir, r) => void (report = r),
  };
  return { host, pages, activated, download: (d: Download) => report?.(d) };
}

function browser() {
  const fake = fakeHost();
  const out: Record<string, unknown>[] = [];
  const b = new EmbeddedBrowser(fake.host, (message) => out.push(message as Record<string, unknown>));
  let id = 0;
  const call = async (method: string, params: object = {}, sessionId?: string) => {
    const n = ++id;
    b.receive({ id: n, method, params, ...(sessionId ? { sessionId } : {}) });
    for (let i = 0; i < 50 && !out.some((m) => m.id === n); i++) await new Promise((r) => setTimeout(r, 1));
    return out.find((m) => m.id === n) as { result?: Record<string, unknown>; error?: { message: string } };
  };
  const events = (method: string) => out.filter((m) => m.method === method) as { params: Record<string, unknown>; sessionId?: string }[];
  return { b, fake, out, call, events };
}

test("the host hears which tabs the person opened, so the others can stay out of their way", async () => {
  const { fake, call } = browser();
  const created = await call("Target.createTarget", { url: "about:blank", finxSession: "s1" });
  const agent = fake.pages.get(created.result!.targetId as string)!;
  assert.equal(agent.byPerson, undefined);
  agent.events.open("https://example.com");
  agent.events.open("about:blank", true);
  const [, page, person] = [...fake.pages.values()];
  assert.equal(page.byPerson, undefined);
  assert.equal(person.byPerson, true);
});

test("tabs are created, attached and driven through their page's debugger", async () => {
  const { fake, call, events } = browser();
  const created = await call("Target.createTarget", { url: "about:blank", finxSession: "s1" });
  const targetId = created.result!.targetId as string;
  assert.equal(events("Target.targetCreated")[0].params.targetInfo && (events("Target.targetCreated")[0].params.targetInfo as { targetId: string }).targetId, targetId);
  const attached = await call("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attached.result!.sessionId as string;
  assert.equal(events("Target.attachedToTarget")[0].params.sessionId, sessionId);

  const page = fake.pages.get(targetId)!;
  const navigated = await call("Page.navigate", { url: "https://example.com" }, sessionId);
  assert.deepEqual(navigated.result, { echo: "Page.navigate" });
  assert.deepEqual(page.sent.at(-1), { method: "Page.navigate", params: { url: "https://example.com" }, session: undefined });

  // An event of the page comes back under the kernel's session.
  page.events.message("Page.loadEventFired", { timestamp: 1 });
  assert.equal(events("Page.loadEventFired")[0].sessionId, sessionId);

  // An iframe the page attached: its events and commands keep its own session.
  page.events.message("Target.attachedToTarget", { sessionId: "child-1", targetInfo: { type: "iframe" } });
  page.events.message("Page.frameNavigated", { frame: { id: "F2" } }, "child-1");
  assert.equal(events("Page.frameNavigated")[0].sessionId, "child-1");
  await call("DOM.resolveNode", { backendNodeId: 3 }, "child-1");
  assert.equal(page.sent.at(-1)!.session, "child-1");
  await call("Target.detachFromTarget", { sessionId: "child-1" });
  assert.deepEqual(page.sent.at(-1), { method: "Target.detachFromTarget", params: { sessionId: "child-1" }, session: undefined });

  await call("Target.activateTarget", { targetId });
  assert.deepEqual(fake.activated, [targetId]);
  const info = await call("Target.getTargetInfo", { targetId });
  assert.equal((info.result!.targetInfo as { attached: boolean }).attached, true);
});

test("commands off the list are refused and never reach a page", async () => {
  const { fake, call } = browser();
  const targetId = (await call("Target.createTarget", { url: "about:blank" })).result!.targetId as string;
  const sessionId = (await call("Target.attachToTarget", { targetId })).result!.sessionId as string;
  for (const [method, session] of [
    ["Runtime.compileScript", sessionId],
    ["Network.setExtraHTTPHeaders", sessionId],
    ["Storage.clearCookies", sessionId],
    ["Browser.grantPermissions", undefined],
    ["Target.exposeDevToolsProtocol", undefined],
  ] as const) {
    const reply = await call(method, {}, session);
    assert.match(reply.error!.message, /not available/, method);
  }
  assert.equal(fake.pages.get(targetId)!.sent.length, 0);
  assert.match((await call("Page.navigate", {}, "no-such-session")).error!.message, /No session/);
});

test("closing, new tabs from a page, downloads, and the browser closing", async () => {
  const { fake, call, events } = browser();
  const targetId = (await call("Target.createTarget", { url: "about:blank", finxSession: "s1" })).result!.targetId as string;
  const sessionId = (await call("Target.attachToTarget", { targetId })).result!.sessionId as string;
  const page = fake.pages.get(targetId)!;

  // window.open: a new target with the opener, for the kernel to attach.
  page.events.open("https://example.com/popup");
  const popup = events("Target.targetCreated").at(-1)!.params.targetInfo as { targetId: string; openerId: string; url: string };
  assert.equal(popup.openerId, targetId);
  assert.equal(popup.url, "https://example.com/popup");

  // Downloads name the tab's main frame.
  await call("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: "/tmp/x", eventsEnabled: true });
  page.events.message("Page.frameNavigated", { frame: { id: "MAIN" } });
  fake.download({ state: "begin", guid: "g1", targetId, url: "https://example.com/f", suggestedFilename: "f.txt" });
  fake.download({ state: "completed", guid: "g1" });
  assert.equal(events("Browser.downloadWillBegin")[0].params.frameId, "MAIN");
  assert.equal(events("Browser.downloadProgress")[0].params.state, "completed");

  await call("Target.closeTarget", { targetId });
  assert.equal(page.closed, true);
  assert.equal(events("Target.detachedFromTarget").at(-1)!.params.sessionId, sessionId);
  assert.equal(events("Target.targetDestroyed").at(-1)!.params.targetId, targetId);
  assert.match((await call("Page.reload", {}, sessionId)).error!.message, /No session/);

  await call("Browser.close");
  assert.equal(fake.pages.get(popup.targetId)!.closed, true);
});

test("handoff discovers only the conversation's existing pages and preserves their state", async () => {
  const { fake, call, events } = browser();
  let adopted = 0;
  let callbacks: PageEvents | undefined;
  fake.host.pending = (session) => session === "new-conversation" && !adopted ? ["home-page"] : [];
  fake.host.adopt = (id, next) => {
    assert.equal(id, "home-page");
    adopted++;
    callbacks = next;
    return {
      url: () => "https://example.com/unsaved-form",
      title: () => "Existing page",
      send: async () => ({ value: "unsaved text" }),
      close: () => {},
    };
  };
  assert.deepEqual((await call("Target.getTargets", { finxSession: "other" })).result, { targetInfos: [] });
  assert.deepEqual((await call("Target.getTargets")).result, { targetInfos: [] });
  const found = await call("Target.getTargets", { finxSession: "new-conversation" });
  const infos = found.result!.targetInfos as { targetId: string; url: string }[];
  assert.equal(infos[0].targetId, "home-page");
  assert.equal(infos[0].url, "https://example.com/unsaved-form");
  assert.equal(fake.pages.size, 0, "handoff must not reload or recreate the page");
  const attached = await call("Target.attachToTarget", { targetId: "home-page" });
  const sessionId = attached.result!.sessionId as string;
  assert.deepEqual((await call("Runtime.evaluate", { expression: "document.body.innerText" }, sessionId)).result, { value: "unsaved text" });
  callbacks!.message("Page.loadEventFired", {});
  assert.equal(events("Page.loadEventFired").at(-1)!.sessionId, sessionId);
  assert.deepEqual((await call("Target.getTargets", { finxSession: "new-conversation" })).result, { targetInfos: [] });
  assert.equal(adopted, 1);
});
