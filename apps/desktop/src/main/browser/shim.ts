import { TargetRelay, type Release, type Target as RelayTarget } from "../../../../chrome-extension/src/relay.js";

// The browser end of the kernel's CDP stream for the embedded browser (browser-design
// §8.3.2). TargetRelay, which the FinxWork extension shares, answers the browser-level
// commands and forwards the page-level ones on the list (D-192); this class says what a page
// is here. Nothing here touches Electron: pages come from a PageHost, so tests can stand in
// for it.

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

type Target = RelayTarget & {
  page: Page;
  /** The page's main frame, as its events name it (for downloads). */
  mainFrame?: string;
};

export class EmbeddedBrowser extends TargetRelay<Target> {
  private readonly host: PageHost;

  /** `send` delivers one CDP message (a response or an event) to the kernel. */
  constructor(host: PageHost, send: (message: object) => void) {
    super(send, "the embedded browser");
    this.host = host;
  }

  /** The finx sessions with tabs, and their tabs, for the windows' panels. */
  tabs(): { targetId: string; finxSession?: string; url: string; title: string }[] {
    return [...this.targets.values()].map((t) => ({ targetId: t.targetId, finxSession: t.finxSession, url: t.page.url(), title: t.page.title() }));
  }

  protected override forward(t: Target, child: string | undefined, method: string, params: object): Promise<unknown> {
    return t.page.send(method, params, child);
  }

  protected override createTarget(url: string, finxSession?: string): string {
    return this.create(url, finxSession).targetId;
  }

  /** Every page that goes is closed: by the kernel, at the end, or after it went by itself. */
  protected override release(t: Target, _how: Release) {
    t.page.close();
  }

  protected override activate(t: Target) {
    this.host.activate(t.targetId);
  }

  protected override downloadBehavior(params: Record<string, unknown>) {
    if (typeof params.downloadPath === "string") this.host.downloads(params.downloadPath, (d) => this.download(d));
  }

  /** User-opened pages handed to a conversation, not yet attached. */
  protected override listTargets(params: Record<string, unknown>): object[] {
    const label = typeof params.finxSession === "string" ? params.finxSession : undefined;
    if (!label) return [];
    for (const id of this.host.pending?.(label) ?? []) {
      if (!this.targets.has(id)) this.create("about:blank", label, undefined, true, id);
    }
    return [...this.targets.values()].filter((t) => t.finxSession === label && !t.sessionId).map((t) => this.info(t));
  }

  protected override describe(t: Target) {
    return { url: t.page.url(), title: t.page.title() };
  }

  /** Notes the main frame (for downloads), even before the kernel attached. */
  protected override pageEvent(t: Target, method: string, params: Record<string, unknown>, child?: string) {
    if (method === "Page.frameNavigated" && !child) {
      const frame = params.frame as { id?: string; parentId?: string } | undefined;
      if (frame && !frame.parentId && frame.id) t.mainFrame = frame.id;
    }
    super.pageEvent(t, method, params, child);
  }

  private create(url: string, finxSession?: string, openerId?: string, byPerson?: boolean, adoptedId?: string): Target {
    const targetId = adoptedId ?? `T${this.next++}`;
    const t = { targetId, finxSession, openerId, byPerson } as Target;
    const events: PageEvents = {
      message: (method, params, session) => this.pageEvent(t, method, params, session),
      changed: () => this.changed(t),
      // A page's new tab is the kernel's to take, owned like its opener (D-205).
      open: (next, byPerson) => {
        if (!this.closed && this.targets.has(targetId)) this.create(next, t.finxSession, targetId, byPerson);
      },
      gone: (reason) => this.drop(t, reason, "gone"),
    };
    t.page = adoptedId && this.host.adopt ? this.host.adopt(adoptedId, events)
      : this.host.create({ targetId, url, finxSession, openerId }, events);
    return this.add(t);
  }

  private download(d: Download) {
    if (d.state === "begin") {
      const t = this.targets.get(d.targetId);
      this.emit("Browser.downloadWillBegin", { guid: d.guid, url: d.url, suggestedFilename: d.suggestedFilename, frameId: t?.mainFrame ?? "" });
    } else {
      this.emit("Browser.downloadProgress", { guid: d.guid, state: d.state, totalBytes: 0, receivedBytes: 0 });
    }
  }
}
