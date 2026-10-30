import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConnectionView,
  ConnectionDiscovery,
  ConnectionsSnapshot,
} from "@finx/protocol";
import { useStore } from "../store";

// Read once per window: the app's icon does not change while FinxWork runs.
export type LocalAdapter = "qwenwork" | "qoder";
export const localAdapters: LocalAdapter[] = ["qwenwork", "qoder"];
const iconRequests = new Map<LocalAdapter, Promise<string | null>>();

/** The local application's own icon (null until read, or when it isn't installed): its mark, where FinxWork shows it. */
export function useSourceAppIcon(adapter: LocalAdapter = "qwenwork") {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    if (!window.finx) return;
    let live = true;
    let request = iconRequests.get(adapter);
    if (!request) { request = window.finx.sourceAppIcon(adapter).catch(() => null); iconRequests.set(adapter, request); }
    void request.then((src) => live && setIcon(src));
    return () => {
      live = false;
    };
  }, [adapter]);
  return icon;
}

/** The local application's mark: its own icon, or a stand-in while there is none. */
export function SourceAppMark({ className, adapter = "qwenwork" }: { className: string; adapter?: LocalAdapter }) {
  const icon = useSourceAppIcon(adapter);
  return icon ? (
    <img className={`${className} source-icon`} src={icon} alt="" draggable={false} />
  ) : (
    <span className={className} aria-hidden="true">
      Q{adapter === "qwenwork" && <i>✦</i>}
    </span>
  );
}

/**
 * A local application connection (an existing login, no key): what is installed, the
 * connection if there is one, and the actions. Discovery runs when this is first used
 * (model settings, or the first-run page), never in the background.
 */
export function useLocalConnection(adapter: LocalAdapter = "qwenwork") {
  const st = useStore();
  const [discovery, setDiscovery] = useState<ConnectionDiscovery | null>(null);
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const mounted = useRef(true);
  const idempotencyKey = useRef(crypto.randomUUID());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const call = st.call;
  useEffect(() => {
    if (!st.rpc) return;
    let stopped = false;
    let revision = -1;
    const update = (s: ConnectionsSnapshot) => {
      if (!stopped && s.revision >= revision) {
        revision = s.revision;
        setConnection(s.connections.find(c => c.adapter_id === adapter) ?? null);
        setLoadError("");
      }
    };
    const refresh = () => {
      void call("connections/list", {})
        .then(update)
        .catch((e) => {
          if (!stopped) setLoadError(String(e));
        });
    };
    const off = st.rpc.on("models/changed", refresh);
    void Promise.all([
      call("connections/list", {}),
      call("connections/discover", {}),
    ])
      .then(([s, d]) => {
        update(s);
        if (!stopped) setDiscovery(d.discoveries.find(d => d.adapter_id === adapter) ?? null);
      })
      .catch((e) => {
        if (!stopped) setLoadError(String(e));
      });
    return () => {
      stopped = true;
      off();
    };
  }, [call, st.rpc, adapter]);
  const act = async (
    action: "connect" | "retry" | "disconnect" | "remove" | "scan",
  ) => {
    setBusy(true);
    setError("");
    try {
      if (action === "scan") {
        const discovered = await call("connections/discover", {});
        if (mounted.current) setDiscovery(discovered.discoveries.find(d => d.adapter_id === adapter) ?? null);
      } else {
        const id = { connection_id: connection?.connection_id ?? "" };
        const result =
          action === "connect"
            ? await call("connections/connect", {
                adapter_id: adapter,
                discovery_id: discovery!.discovery_id,
                idempotency_key: idempotencyKey.current,
              })
            : action === "retry"
              ? await call("connections/retry", id)
              : action === "disconnect"
                ? await call("connections/disconnect", id)
                : await call("connections/remove", id);
        if (mounted.current) setConnection(result.connections.find(c => c.adapter_id === adapter) ?? null);
        await st.refreshModels();
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      try {
        const snapshot = await call("connections/list", {});
        if (mounted.current) setConnection(snapshot.connections.find(c => c.adapter_id === adapter) ?? null);
      } catch { /* Keep the original actionable error. */ }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const open = () => { void window.finx?.openSourceApp(adapter).catch(e => { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }); };
  const ready = connection?.state === "ready";
  const status =
    connection?.state ??
    (!discovery ? "checking" : discovery.installed ? "found" : "missing");
  const published = new Set(st.models.models.filter(m => m.provider === `local-${connection?.connection_id}`).map(m => m.id));
  const active = connection?.models.filter(m => published.has(`local-${connection.connection_id}/${m.id}`)) ?? [];
  const pending = connection?.models.filter(m => !published.has(`local-${connection.connection_id}/${m.id}`)) ?? [];
  return { discovery, connection, active, pending, open, busy, error: error || loadError, act, status, ready, rpc: !!st.rpc } as const;
}

/**
 * The local application as one card (the first-run page): its icon and name, one sentence
 * on what connecting gives or what is missing, and the way forward.
 */
export function LocalApplicationConnection() {
  const { t } = useTranslation("settings");
  return <section aria-label={t("connections.local")}>
    <div className="connections-section-heading"><div><h3>{t("connections.local")}</h3><p>{t("local.note")}</p></div></div>
    {localAdapters.map(adapter => <LocalApplicationCard key={adapter} adapter={adapter} />)}
  </section>;
}
function LocalApplicationCard({ adapter }: { adapter: LocalAdapter }) {

  const { t } = useTranslation("settings");
  const { discovery, connection, active, open, busy, error, act, rpc } = useLocalConnection(adapter);
  const name = adapter === "qoder" ? "Qoder" : t("models.qwen");
  const state = connection?.state;
  const run = (a: Parameters<typeof act>[0]) => () => void act(a);
  // What to say, the status beside the name, and the buttons (the first is the way forward).
  const [say, status, actions]: [string, string, [string, () => void][]] = (() => {
    if (state === "ready") return [t("local.ready", { count: active.length }), t("models.state.ready", { count: active.length }), []];
    if (state === "connecting") return [t("local.found", { name }), t("models.state.connecting"), []];
    if (state === "needs_login") return [t("local.needsLogin", { name }), t("models.state.signedOut"), [[t("models.open", { name }), open], [t("models.reconnect"), run("retry")]]];
    if (state) return [t("local.trouble", { name }), t("models.state.trouble"), [[t("models.reconnect"), run("retry")]]];
    if (!discovery) return [t("local.found", { name }), t(error ? "models.state.unknown" : "models.state.checking"), error ? [[t("models.recheck"), run("scan")]] : []];
    if (!discovery.installed) return [t("local.missing", { name }), t("models.state.missing"), [[t("models.recheck"), run("scan")]]];
    if (discovery.login === "missing") return [t("local.signedOut", { name }), t("models.state.signedOut"), [[t("models.open", { name }), open], [t("models.recheck"), run("scan")]]];
    return [t("local.found", { name }), t("models.state.found", { version: discovery.version ?? "" }).trim(), [[t("local.connect", { name }), run("connect")]]];
  })();
  return (
      <article className={`connection-card ${state === "ready" ? "is-connected" : ""}`}>
        <div className="connection-provider">
          <SourceAppMark className="connection-logo" adapter={adapter} />
          <div className="connection-provider-name">
            <h4>{name}</h4>
            <p>{status}</p>
          </div>
        </div>
        <div className="connection-description">
          <p>{say}</p>
          {error && discovery && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
        </div>
        {actions.length > 0 && (
          <div className="connection-card-footer local-actions">
            {actions.map(([label, go], i) => (
              <button key={label} className={`btn ${i === 0 ? "primary" : ""}`} disabled={busy || !rpc} onClick={go}>
                {busy && i === 0 ? t("models.state.connecting") : label}
              </button>
            ))}
          </div>
        )}
      </article>
  );
}
