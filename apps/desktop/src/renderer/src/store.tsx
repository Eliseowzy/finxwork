import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { listView, mergeSessions, RpcError, RpcClient, type ListSession, type ListView } from "@finx/client";
import type { Methods, ModelsListResult, Op, PermissionMode, ThinkingLevel } from "@finx/protocol";
import type { KernelStatusView } from "../../shared/bridge";
import { i18n } from "../../shared/i18n";
import { toInput, type Attachment } from "./composer/attachments";
import { connect } from "./kernel";

// What the window knows: the session list as finx pushes it (P1, no
// polling), the models, and the window's own state (selection, list view,
// open sheet, toast). A session's conversation is its page's
// (session/useSession.ts).

export type Selection = { kind: "new" } | { kind: "session"; id: string };

export type Sheet = { kind: "confirm"; title: string; message: string; button: string; cancel?: string; run: () => Promise<unknown>; done?: string };

export type Toast = { text: string; undo?: () => void; bad?: boolean; id: number };

/** What a new session starts with, chosen on the new session page. */
export type Draft = { cwd: string | null; model: string | null; thinking: ThinkingLevel; permission: PermissionMode };

type UI = {
  selection: Selection;
  inspector: boolean;
  /** The background panel is shown, in the info card's place. */
  background: boolean;
  /** The sub-agent open in the background panel. */
  agent: string | null;
  sidebar: boolean;
  view: ListView;
  /** The list shows archived sessions. */
  archived: boolean;
  /** Collapsed groups, as "grouping:key" (each grouping keeps its own). */
  collapsed: string[];
  searching: boolean;
  /** The session whose title is being edited in the list. */
  renaming: string | null;
  sheet: Sheet | null;
  toast: Toast | null;
  draft: Draft;
};

const noModels: ModelsListResult = { models: [], providers: [] };

/** The window's connection: first connecting, ready, reconnecting after it ended, or down (finx failed to run). */
export type KernelState = "connecting" | "ready" | "reconnecting" | "down";

export type Store = UI & {
  rpc: RpcClient | null;
  kernel: KernelState;
  /** The service as the main process sees it; null in a browser preview. */
  status: KernelStatusView | null;
  /** finx's name and version as it introduced itself. */
  server: string;
  sessions: ListSession[];
  /** The list arrived. */
  loaded: boolean;
  /** Models, providers with their keys, and the defaults of a new session. */
  models: ModelsListResult;
  set: (patch: Partial<UI>) => void;
  select: (id: string) => void;
  /** Runs a change against finx; failures become a toast. Resolves to whether it worked. */
  run: (action: () => Promise<unknown>, done?: string) => Promise<boolean>;
  show: (text: string, undo?: () => void, bad?: boolean) => void;
  call: <M extends keyof Methods & string>(method: M, params: Methods[M][0]) => Promise<Methods[M][1]>;
  op: (sessionId: string, op: Op) => Promise<boolean>;
  /** Asks finx for the models again (after a key was saved or removed). */
  refreshModels: () => Promise<void>;
  /** Starts a session as a new session's draft says, and sends it its first message (folders attached become more of its roots). */
  start: (text: string, d: Draft, attachments: Attachment[]) => Promise<boolean>;
};

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside FinxProvider");
  return s;
}

/** An error from finx, for the person. */
export function errorText(e: unknown): string {
  if (e instanceof RpcError) return e.kind === "disconnected" ? i18n.t("common:kernel.down") : e.message;
  return e instanceof Error ? e.message : String(e);
}

type Saved = Pick<UI, "selection" | "sidebar" | "inspector" | "view" | "archived" | "collapsed"> & { draft: Partial<Draft> };

function saved(): Partial<Saved> {
  if (location.hash.startsWith("#settings")) return {};
  try {
    const v: Partial<Saved> = JSON.parse(localStorage.getItem("main-view") ?? "{}");
    return { ...v, view: listView(v.view), collapsed: Array.isArray(v.collapsed) ? v.collapsed : undefined };
  } catch {
    return {};
  }
}

export function FinxProvider({ children }: { children: ReactNode }) {
  const [rpc, setRpc] = useState<RpcClient | null>(null);
  const [kernel, setKernel] = useState<KernelState>("connecting");
  const [status, setStatus] = useState<KernelStatusView | null>(null);
  const [server, setServer] = useState("");
  const [sessions, setSessions] = useState<ListSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [models, setModels] = useState<ModelsListResult>(noModels);
  const [ui, setUI] = useState<UI>(() => {
    const s = saved();
    return {
      selection: s.selection ?? { kind: "new" },
      inspector: s.inspector ?? true,
      background: false,
      agent: null,
      sidebar: s.sidebar ?? true,
      view: s.view ?? listView(),
      archived: s.archived ?? false,
      collapsed: s.collapsed ?? [],
      searching: false,
      renaming: null,
      sheet: null,
      toast: null,
      draft: { cwd: null, model: null, thinking: "medium", permission: "manual", ...s.draft },
    };
  });

  // finx's service as the main process's supervisor sees it (in the app; a
  // page in a browser runs its own mock, always ready).
  useEffect(() => {
    if (!window.finx) return;
    void window.finx.kernelStatus().then(setStatus);
    return window.finx.onKernelState(setStatus);
  }, []);
  const serviceReady = !window.finx || window.finx.kernel === "mock" || status?.state === "ready";

  // The window's own connection: made once the service is ready, and made
  // again whenever it ends (desktop-kernel-integration §6.2). Pages that
  // follow `rpc` attach again with fresh snapshots; drafts stay where they are.
  const client = useRef<RpcClient | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!serviceReady || client.current) return;
    let stop = false;
    connect()
      .then(({ rpc: c, server }) => {
        if (stop) return;
        client.current = c;
        c.onClose(() => {
          if (client.current !== c) return;
          client.current = null;
          setRpc(null);
          setKernel("reconnecting");
          // The supervisor may not have noticed yet; try again shortly either way.
          setTimeout(() => setAttempt((n) => n + 1), 400);
        });
        setServer(server);
        setRpc(c);
      })
      .catch(() => {
        if (stop) return;
        setKernel("reconnecting");
        setTimeout(() => setAttempt((n) => n + 1), 1000);
      });
    return () => {
      stop = true;
    };
  }, [serviceReady, attempt]);

  // On each connection: the list from then on as finx pushes it, and the models.
  useEffect(() => {
    if (!rpc) return;
    let stop = false;
    const offModels = rpc.on("models/changed", () => { void rpc.request("models/list", {}).then(m => { if (!stop) setModels(m); }).catch(() => {}); });
    const off = rpc.on("sessions/changed", (c) => setSessions((list) => mergeSessions(list, c.sessions, c.deleted ?? [])));
    Promise.all([rpc.request("sessions/subscribe", {}), rpc.request("models/list", {})])
      .then(([list, m]) => {
        if (stop) return;
        setSessions(list.sessions);
        setModels(m);
        setLoaded(true);
        setKernel("ready");
      })
      .catch(() => {});
    return () => {
      stop = true;
      off();
      offModels();
    };
  }, [rpc]);
  const kernelState: KernelState = status?.state === "failed" ? "down" : kernel;

  useEffect(() => {
    if (location.hash.startsWith("#settings")) return;
    const v: Saved = { selection: ui.selection, sidebar: ui.sidebar, inspector: ui.inspector, view: ui.view, archived: ui.archived, collapsed: ui.collapsed, draft: ui.draft };
    try {
      localStorage.setItem("main-view", JSON.stringify(v));
    } catch {
      // The window's layout is a convenience; without storage it just doesn't stick.
    }
  }, [ui.selection, ui.sidebar, ui.inspector, ui.view, ui.archived, ui.collapsed, ui.draft]);

  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const set = useCallback((patch: Partial<UI>) => setUI((u) => ({ ...u, ...patch })), []);
  const select = useCallback((id: string) => setUI((u) => ({ ...u, selection: { kind: "session", id } })), []);
  const show = useCallback((text: string, undo?: () => void, bad?: boolean) => {
    clearTimeout(toastTimer.current);
    const id = Date.now();
    setUI((u) => ({ ...u, toast: { text, undo, bad, id } }));
    toastTimer.current = setTimeout(() => setUI((u) => (u.toast?.id === id ? { ...u, toast: null } : u)), 5200);
  }, []);
  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string) => {
      try {
        await action();
        if (done) show(done);
        return true;
      } catch (e) {
        show(errorText(e), undefined, true);
        return false;
      }
    },
    [show],
  );
  const call = useCallback(
    <M extends keyof Methods & string>(method: M, params: Methods[M][0]) => (rpc ? rpc.request(method, params) : Promise.reject(new Error(i18n.t("common:kernel.connecting")))),
    [rpc],
  );
  const op = useCallback((sessionId: string, o: Op) => run(() => call("session/op", { session_id: sessionId, op: o })), [run, call]);
  const refreshModels = useCallback(async () => {
    if (rpc) setModels(await rpc.request("models/list", {}));
  }, [rpc]);
  const start = useCallback(
    (text: string, d: Draft, attachments: Attachment[]) =>
      run(async () => {
        if (!d.cwd) throw new Error(i18n.t("session:new.pickFirst"));
        const roots = attachments.flatMap((a) => (a.kind === "folder" ? [a.path] : []));
        const r = await call("session/new", { cwd: d.cwd, extra_roots: roots.length ? roots : undefined, model: d.model ?? undefined, thinking: d.thinking, permission_mode: d.permission });
        setUI((u) => ({ ...u, draft: d, selection: { kind: "session", id: r.session_id } }));
        await call("session/op", { session_id: r.session_id, op: { type: "prompt", input: toInput(text, attachments.filter((a) => a.kind !== "folder")) } });
      }),
    [run, call],
  );

  const store = useMemo<Store>(
    () => ({ ...ui, rpc, kernel: kernelState, status, server, sessions, loaded, models, set, select, run, show, call, op, refreshModels, start }),
    [ui, rpc, kernelState, status, server, sessions, loaded, models, set, select, run, show, call, op, refreshModels, start],
  );
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

/**
 * The current time, ticking every interval ms (for elapsed times). One clock
 * per interval for the whole window, so everything on the same interval
 * changes in the same frame. Ticks fall halfway between wall-clock
 * multiples of interval, so a clock counting whole seconds moves by exactly
 * one on each, however late a tick comes.
 */
export function useNow(interval = 1000): Date {
  const c = clock(interval);
  return useSyncExternalStore(c.subscribe, c.now);
}

const clocks = new Map<number, { subscribe: (f: () => void) => () => void; now: () => Date }>();

function clock(interval: number) {
  let c = clocks.get(interval);
  if (c) return c;
  const subs = new Set<() => void>();
  let now = new Date();
  let timer: ReturnType<typeof setTimeout> | undefined;
  c = {
    subscribe(f) {
      if (subs.size === 0) {
        now = new Date();
        const next = () => {
          timer = setTimeout(() => {
            now = new Date();
            subs.forEach((g) => g());
            next();
          }, interval - ((Date.now() + interval / 2) % interval));
        };
        next();
      }
      subs.add(f);
      return () => {
        subs.delete(f);
        if (subs.size === 0) clearTimeout(timer);
      };
    },
    now: () => now,
  };
  clocks.set(interval, c);
  return c;
}
