import { browserMethods, pageMethods } from "./methods.ts";

// The browser end of the kernel's CDP stream for the embedded browser (browser-design
// §8.3.2). A page's debugger only knows its own page, so the browser-level Target and
// Browser commands finx-browser sends are answered here; page-level ones go to the page's
// debugger, and only those on the list (D-192). Nothing here touches Electron: pages come
// from a PageHost, so tests can stand in for it.

/** A page with its debugger attached. */
export interface Page {
  /** `debugger.sendCommand`; `session` for a child target the page attached (an iframe). */
  send(method: string, params: object, session?: string): Promise<unknown>;
  url(): string;
  title(): string;
  close(): void;
}

/** What the browser end tells the page host about. */
export interface PageEvents {
  /** A debugger event; `session` for a child target. */
  message(method: string, params: Record<string, unknown>, session?: string): void;
  /** The URL or the title changed. */
  changed(): void;
  /** A new tab beside this one: the page asked (window.open, target=_blank), or the person
   * did in the panel (`byPerson`). */
  open(url: string, byPerson?: boolean): void;
  /** The page is gone: closed by the person, crashed, or its debugger detached. */
  gone(reason: string): void;
}

export interface PageHost {
  create(o: { targetId: string; url: string; finxSession?: string; openerId?: string }, events: PageEvents): Page;
  /** User-opened tabs explicitly handed to this conversation, active tab last. */
  pending?(finxSession: string): string[];
  adopt?(targetId: string, events: PageEvents): Page;
  /** Show the tab in its window's panel. */
  activate(targetId: string): void;
  /** Where downloads go; `report` is called as each one starts and ends. */
  downloads(dir: string, report: (d: Download) => void): void;
}

export type Download =
  | { state: "begin"; guid: string; targetId: string; url: string; suggestedFilename: string }
  | { state: "completed" | "canceled"; guid: string };

type Command = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };

type Target = {
  targetId: string;
  page: Page;
  finxSession?: string;
  openerId?: string;
  /** Set once the kernel attached. */
  sessionId?: string;
  /** The page's main frame, as its events name it (for downloads). */
  mainFrame?: string;
  /** Opened by the person in the panel, not by a page. */
  byPerson?: boolean;
};

const browserLevel = new Set(browserMethods);
const pageLevel = new Set(pageMethods);

export class EmbeddedBrowser {
  private readonly targets = new Map<string, Target>();
  /** Sessions the kernel addresses: a page's own, or a child target of a page. */
  private readonly sessions = new Map<string, { target: Target; child?: string }>();
  private next = 1;
  private closed = false;

  private readonly host: PageHost;
  private readonly send: (data: string) => void;

  /** `send` delivers one CDP message (a response or an event) to the kernel. */
  constructor(host: PageHost, send: (data: string) => void) {
    this.host = host;
    this.send = send;
  }

  /** The finx sessions with tabs, and their tabs, for the windows' panels. */
  tabs(): { targetId: string; finxSession?: string; url: string; title: string }[] {
    return [...this.targets.values()].map((t) => ({ targetId: t.targetId, finxSession: t.finxSession, url: t.page.url(), title: t.page.title() }));
  }

  /** One message from the kernel: a command. */
  receive(data: string) {
    let command: Command;
    try {
      command = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof command.id !== "number" || typeof command.method !== "string") return;
    void this.handle(command).then(
      (result) => this.emitRaw({ id: command.id, result: result ?? {} }),
      (e: unknown) => this.emitRaw({ id: command.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }),
    );
  }

  /** The kernel went away or closed the browser: every page goes. */
  close() {
    this.closed = true;
    for (const t of [...this.targets.values()]) this.drop(t, "the browser closed", false);
  }

  private async handle(c: Command): Promise<unknown> {
    const params = c.params ?? {};
    if (c.sessionId !== undefined) {
      const s = this.sessions.get(c.sessionId);
      if (!s) throw new Error(`No session with given id ${c.sessionId}`);
      if (!pageLevel.has(c.method)) throw new Error(`${c.method} is not available in the embedded browser`);
      return s.target.page.send(c.method, params, s.child);
    }
    if (!browserLevel.has(c.method)) throw new Error(`${c.method} is not available in the embedded browser`);
    switch (c.method) {
      case "Target.setDiscoverTargets":
        return {};
      case "Browser.setDownloadBehavior":
        if (typeof params.downloadPath === "string") this.host.downloads(params.downloadPath, (d) => this.download(d));
        return {};
      case "Browser.close":
        this.close();
        return {};
      case "Target.createTarget": {
        const url = typeof params.url === "string" ? params.url : "about:blank";
        const finxSession = typeof params.finxSession === "string" ? params.finxSession : undefined;
        return { targetId: this.create(url, finxSession).targetId };
      }
      case "Target.attachToTarget": {
        const t = this.target(params.targetId);
        if (t.sessionId) throw new Error("the target is attached already");
        t.sessionId = `S${this.next++}-${t.targetId}`;
        this.sessions.set(t.sessionId, { target: t });
        this.emit("Target.attachedToTarget", { sessionId: t.sessionId, targetInfo: this.info(t), waitingForDebugger: false });
        return { sessionId: t.sessionId };
      }
      case "Target.detachFromTarget": {
        const s = typeof params.sessionId === "string" ? this.sessions.get(params.sessionId) : undefined;
        // A child target (an iframe, a worker) is the page's to detach; a page stays attached.
        if (s?.child) return s.target.page.send("Target.detachFromTarget", { sessionId: s.child });
        return {};
      }
      case "Target.closeTarget":
        this.drop(this.target(params.targetId), "the tab was closed", true);
        return { success: true };
      case "Target.activateTarget":
        this.host.activate(this.target(params.targetId).targetId);
        return {};
      case "Target.getTargets": {
        const label = typeof params.finxSession === "string" ? params.finxSession : undefined;
        if (!label) return { targetInfos: [] };
        for (const id of this.host.pending?.(label) ?? []) {
          if (!this.targets.has(id)) this.create("about:blank", label, undefined, true, id);
        }
        return { targetInfos: [...this.targets.values()].filter((t) => t.finxSession === label && !t.sessionId).map((t) => this.info(t)) };
      }
      case "Target.getTargetInfo":
        return { targetInfo: this.info(this.target(params.targetId)) };
    }
    throw new Error(`${c.method} is not available in the embedded browser`);
  }

  private target(id: unknown): Target {
    const t = typeof id === "string" ? this.targets.get(id) : undefined;
    if (!t) throw new Error(`No target with given id ${String(id)}`);
    return t;
  }

  private create(url: string, finxSession?: string, openerId?: string, byPerson?: boolean, adoptedId?: string): Target {
    const targetId = adoptedId ?? `T${this.next++}`;
    const t = { targetId, finxSession, openerId, byPerson } as Target;
    const events: PageEvents = {
      message: (method, params, session) => this.pageEvent(t, method, params, session),
      changed: () => {
        if (this.targets.has(targetId)) this.emit("Target.targetInfoChanged", { targetInfo: this.info(t) });
      },
      // A page's new tab is the kernel's to take, owned like its opener (D-205).
      open: (next, byPerson) => {
        if (!this.closed && this.targets.has(targetId)) this.create(next, t.finxSession, targetId, byPerson);
      },
      gone: (reason) => this.drop(t, reason, false),
    };
    t.page = adoptedId && this.host.adopt ? this.host.adopt(adoptedId, events)
      : this.host.create({ targetId, url, finxSession, openerId }, events);
    this.targets.set(targetId, t);
    this.emit("Target.targetCreated", { targetInfo: this.info(t) });
    return t;
  }

  private info(t: Target) {
    return {
      targetId: t.targetId,
      type: "page",
      title: t.page.title(),
      url: t.page.url(),
      attached: !!t.sessionId,
      canAccessOpener: false,
      ...(t.openerId ? { openerId: t.openerId } : {}),
      // So the kernel tells the model who opened it.
      ...(t.byPerson ? { finxOpenedBy: "person" } : {}),
    };
  }

  /** An event of a page's debugger, passed on under the session the kernel knows. */
  private pageEvent(t: Target, method: string, params: Record<string, unknown>, child?: string) {
    if (method === "Page.frameNavigated" && !child) {
      const frame = params.frame as { id?: string; parentId?: string } | undefined;
      if (frame && !frame.parentId && frame.id) t.mainFrame = frame.id;
    }
    if (!t.sessionId) return;
    const sessionId = child ? this.childSession(t, child) : t.sessionId;
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
      this.sessions.set(params.sessionId, { target: t, child: params.sessionId });
    }
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      this.sessions.delete(params.sessionId);
    }
    this.emit(method, params, sessionId);
  }

  /** A child's session id is the page's debugger's own, registered when it attached. */
  private childSession(t: Target, child: string): string {
    if (!this.sessions.has(child)) this.sessions.set(child, { target: t, child });
    return child;
  }

  private drop(t: Target, reason: string, closePage: boolean) {
    if (!this.targets.delete(t.targetId)) return;
    for (const [id, s] of this.sessions) if (s.target === t) this.sessions.delete(id);
    if (closePage) t.page.close();
    if (t.sessionId) this.emit("Target.detachedFromTarget", { sessionId: t.sessionId, targetId: t.targetId, reason });
    this.emit("Target.targetDestroyed", { targetId: t.targetId });
    if (!closePage) t.page.close();
  }

  private download(d: Download) {
    if (d.state === "begin") {
      const t = this.targets.get(d.targetId);
      this.emit("Browser.downloadWillBegin", { guid: d.guid, url: d.url, suggestedFilename: d.suggestedFilename, frameId: t?.mainFrame ?? "" });
    } else {
      this.emit("Browser.downloadProgress", { guid: d.guid, state: d.state, totalBytes: 0, receivedBytes: 0 });
    }
  }

  private emit(method: string, params: object, sessionId?: string) {
    this.emitRaw(sessionId ? { method, params, sessionId } : { method, params });
  }

  private emitRaw(message: object) {
    if (!this.closed || "id" in message) this.send(JSON.stringify(message));
  }
}
