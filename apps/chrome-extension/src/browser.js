import { browserMethods, pageMethods } from "./methods.js";

// The browser end of the kernel's CDP stream in the user's Chrome (browser-design §8.4).
// chrome.debugger only attaches to a tab, so the browser-level Target and Browser commands
// finx-browser sends are answered here, as the desktop app's embedded browser does (D-210);
// page-level ones go to the tab's debugger, and only those on the list (D-192).
//
// Only tabs the agent opened, and tabs those tabs opened, are ever attached: the user's
// other tabs are never seen. Nothing here touches the chrome.* APIs: they come in as a
// `Tabs`, so tests can stand in for them.

/**
 * @typedef {object} Tabs
 * @property {(url: string, label?: string) => Promise<number>} create  A new tab of the agent's; its id.
 * @property {(tabId: number, label?: string) => void} adopt  A tab an agent tab opened joins its group.
 * @property {(tabId: number) => void} close
 * @property {(tabId: number) => void} activate
 * @property {(tabId: number) => Promise<void>} attach  Attaches the debugger.
 * @property {(tabId: number) => void} detach
 * @property {(tabId: number, child: string | undefined, method: string, params: object) => Promise<unknown>} send
 */

const browserLevel = new Set(browserMethods);
const pageLevel = new Set(pageMethods);

export class ExtensionBrowser {
  /**
   * @param {Tabs} tabs
   * @param {(data: string) => void} send  Delivers one CDP message (a response or an event) to the kernel.
   */
  constructor(tabs, send) {
    this.tabs = tabs;
    this.send = send;
    /** @type {Map<string, Target>} */
    this.targets = new Map();
    /** @type {Map<number, Target>} */
    this.byTab = new Map();
    /** Sessions the kernel addresses: a tab's own, or a child target of a tab. @type {Map<string, {target: Target, child?: string}>} */
    this.sessions = new Map();
    this.next = 1;
    this.closed = false;
  }

  /** One message from the kernel: a command. */
  receive(data) {
    let command;
    try {
      command = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof command.id !== "number" || typeof command.method !== "string") return;
    this.handle(command).then(
      (result) => this.emitRaw({ id: command.id, result: result ?? {} }),
      (e) => this.emitRaw({ id: command.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }),
    );
  }

  /** The kernel went away: let go of every tab, but leave them open for the user. */
  close() {
    this.closed = true;
    for (const t of [...this.targets.values()]) this.drop(t, "the browser closed", { detach: true });
  }

  // ---- What Chrome reports ----

  /** A debugger event of a tab; `child` for a child target the tab attached (an iframe). */
  event(tabId, child, method, params) {
    const t = this.byTab.get(tabId);
    if (!t?.sessionId) return;
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
      this.sessions.set(params.sessionId, { target: t, child: params.sessionId });
    }
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      this.sessions.delete(params.sessionId);
    }
    if (child && !this.sessions.has(child)) this.sessions.set(child, { target: t, child });
    this.emit(method, params, child ?? t.sessionId);
  }

  /** The debugger let go: the user closed the "is debugging this browser" bar, or the tab
   * crashed or went somewhere Chrome does not let extensions in. The tab stays open, but
   * it is no longer the agent's. */
  detached(tabId, reason) {
    const t = this.byTab.get(tabId);
    if (!t) return;
    const why = reason === "canceled_by_user" ? "the user stopped the agent's control of the tab" : `the debugger detached (${reason})`;
    this.drop(t, why, { detach: false });
  }

  /** A tab was opened. One that a tab of the agent's opened is the agent's too, owned like
   * its opener (D-205); any other is the user's and stays unseen. */
  tabCreated(tabId, openerTabId, url) {
    if (this.closed || this.byTab.has(tabId)) return;
    const opener = openerTabId === undefined ? undefined : this.byTab.get(openerTabId);
    if (!opener) return;
    const t = this.register(tabId, url || "about:blank", opener.finxSession, opener.targetId);
    this.tabs.adopt(tabId, t.finxSession);
  }

  tabUpdated(tabId, { url, title }) {
    const t = this.byTab.get(tabId);
    if (!t) return;
    if (typeof url === "string") t.url = url;
    if (typeof title === "string") t.title = title;
    this.emit("Target.targetInfoChanged", { targetInfo: this.info(t) });
  }

  tabRemoved(tabId) {
    const t = this.byTab.get(tabId);
    if (t) this.drop(t, "the tab was closed", { detach: false });
  }

  // ---- Commands ----

  async handle(c) {
    const params = c.params ?? {};
    if (c.sessionId !== undefined) {
      const s = this.sessions.get(c.sessionId);
      if (!s) throw new Error(`No session with given id ${c.sessionId}`);
      if (!pageLevel.has(c.method)) throw new Error(`${c.method} is not available in the FinxWork extension`);
      return this.tabs.send(s.target.tabId, s.child, c.method, params);
    }
    if (!browserLevel.has(c.method)) throw new Error(`${c.method} is not available in the FinxWork extension`);
    switch (c.method) {
      case "Target.setDiscoverTargets":
        return {};
      case "Browser.setDownloadBehavior":
        // Downloads go where the user's Chrome puts them; the kernel is not told.
        return {};
      case "Browser.close":
        this.close();
        return {};
      case "Target.createTarget": {
        const url = typeof params.url === "string" ? params.url : "about:blank";
        const finxSession = typeof params.finxSession === "string" ? params.finxSession : undefined;
        const tabId = await this.tabs.create(url, finxSession);
        if (this.closed) {
          this.tabs.close(tabId);
          throw new Error("the browser closed");
        }
        return { targetId: (this.byTab.get(tabId) ?? this.register(tabId, url, finxSession)).targetId };
      }
      case "Target.attachToTarget": {
        const t = this.target(params.targetId);
        if (t.sessionId) throw new Error("the target is attached already");
        await this.tabs.attach(t.tabId);
        if (!this.targets.has(t.targetId)) {
          this.tabs.detach(t.tabId);
          throw new Error("the tab was closed");
        }
        t.sessionId = `S${this.next++}-${t.targetId}`;
        this.sessions.set(t.sessionId, { target: t });
        this.emit("Target.attachedToTarget", { sessionId: t.sessionId, targetInfo: this.info(t), waitingForDebugger: false });
        return { sessionId: t.sessionId };
      }
      case "Target.detachFromTarget": {
        const s = typeof params.sessionId === "string" ? this.sessions.get(params.sessionId) : undefined;
        // A child target is the tab's to detach; a tab stays attached until it is closed.
        if (s?.child) return this.tabs.send(s.target.tabId, undefined, "Target.detachFromTarget", { sessionId: s.child });
        return {};
      }
      case "Target.closeTarget":
        this.drop(this.target(params.targetId), "the tab was closed", { close: true });
        return { success: true };
      case "Target.activateTarget":
        this.tabs.activate(this.target(params.targetId).tabId);
        return {};
      case "Target.getTargets":
        // The user does not hand tabs of their own to the agent here.
        return { targetInfos: [] };
      case "Target.getTargetInfo":
        return { targetInfo: this.info(this.target(params.targetId)) };
    }
    throw new Error(`${c.method} is not available in the FinxWork extension`);
  }

  target(id) {
    const t = typeof id === "string" ? this.targets.get(id) : undefined;
    if (!t) throw new Error(`No target with given id ${String(id)}`);
    return t;
  }

  register(tabId, url, finxSession, openerId) {
    /** @typedef {{targetId: string, tabId: number, url: string, title: string, finxSession?: string, openerId?: string, sessionId?: string}} Target */
    const t = { targetId: `T${tabId}`, tabId, url, title: "", finxSession, openerId };
    this.targets.set(t.targetId, t);
    this.byTab.set(tabId, t);
    this.emit("Target.targetCreated", { targetInfo: this.info(t) });
    return t;
  }

  info(t) {
    return {
      targetId: t.targetId,
      type: "page",
      title: t.title,
      url: t.url,
      attached: !!t.sessionId,
      canAccessOpener: false,
      ...(t.openerId ? { openerId: t.openerId } : {}),
    };
  }

  /** Forgets a tab: `close` closes it, `detach` lets the debugger go and leaves it open. */
  drop(t, reason, { close = false, detach = false } = {}) {
    if (!this.targets.delete(t.targetId)) return;
    this.byTab.delete(t.tabId);
    for (const [id, s] of this.sessions) if (s.target === t) this.sessions.delete(id);
    if (close) this.tabs.close(t.tabId);
    else if (detach && t.sessionId) this.tabs.detach(t.tabId);
    if (t.sessionId) this.emit("Target.detachedFromTarget", { sessionId: t.sessionId, targetId: t.targetId, reason });
    this.emit("Target.targetDestroyed", { targetId: t.targetId });
  }

  emit(method, params, sessionId) {
    this.emitRaw(sessionId ? { method, params, sessionId } : { method, params });
  }

  emitRaw(message) {
    if (!this.closed || "id" in message) this.send(JSON.stringify(message));
  }
}
