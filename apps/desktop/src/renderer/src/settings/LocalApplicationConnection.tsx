import { TokenPlanConnections } from "./TokenPlanConnections";
import { useCallback, useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConnectionView,
  ConnectionDiagnostic,
  ConnectionDiscovery,
  ConnectionsSnapshot,
} from "@finx/protocol";
import { connectionDiagnostic, rpcConnectionDiagnostic } from "../../../shared/connection-diagnostic";
import { agoText } from "../format";
import { Icon } from "../icons";
import { useStore } from "../store";
import { ManageModels, useModelCounts } from "./ManageModels";
import { ChatGptConnection } from "./ChatGptConnection";

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
  const [operationDiagnostic, setOperationDiagnostic] = useState<ConnectionDiagnostic | null>(null);
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
        const next = s.connections.find(c => c.adapter_id === adapter) ?? null;
        setConnection(next);
        if (next?.state === "ready" && !next.diagnostic) {
          setOperationDiagnostic(null);
          setError("");
        }
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
    action: "connect" | "retry" | "disconnect" | "remove" | "scan" | "models",
  ) => {
    setBusy(true);
    setError("");
    setOperationDiagnostic(null);
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
              : action === "models"
              ? await call("connections/models", id)
              : action === "disconnect"
                ? await call("connections/disconnect", id)
                : await call("connections/remove", id);
        if (mounted.current) setConnection(result.connections.find(c => c.adapter_id === adapter) ?? null);
        await st.refreshModels();
      }
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : String(e));
        setOperationDiagnostic(rpcConnectionDiagnostic(e));
      }
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
    (!discovery ? "checking" : discovery.diagnostic ? "unavailable" : discovery.installed ? "found" : "missing");
  const published = new Set(st.models.models.filter(m => m.provider === connection?.provider_id).map(m => m.id));
  const active = connection?.models.filter(m => published.has(`${connection.provider_id}/${m.id}`)) ?? [];
  const pending = connection?.models.filter(m => !published.has(`${connection.provider_id}/${m.id}`)) ?? [];
  const diagnostic = connectionDiagnostic(connection, operationDiagnostic) ?? discovery?.diagnostic ?? null;
  return { discovery, connection, diagnostic, active, pending, open, busy, error: error || loadError, act, status, ready, rpc: !!st.rpc } as const;
}

/** A local application's name, as FinxWork shows it. */
export function useLocalName() {
  const { t } = useTranslation("settings");
  return (adapter: LocalAdapter) => (adapter === "qoder" ? "Qoder" : t("models.qwen"));
}

/**
 * A local application as a grouped row (Settings › Models, the first-run page): its mark,
 * the name over its state, and the actions, the first the way forward. `primary` says
 * whether that first one is drawn as the main button (by default, while not connected);
 * `onStatus` hears the row's status, `hidden` keeps the row's connection without drawing it.
 */
export function LocalRow({ adapter, primary, hidden, onStatus }: { adapter: LocalAdapter; primary?: boolean; hidden?: boolean; onStatus?: (adapter: LocalAdapter, status: string) => void }) {
  const { t } = useTranslation("settings");
  const local = useLocalConnection(adapter);
  const name = useLocalName()(adapter);
  const { discovery, connection, diagnostic, busy, status } = local;
  useEffect(() => onStatus?.(adapter, status), [onStatus, adapter, status]);
  const state = connection?.state;
  const act = (a: Parameters<typeof local.act>[0]) => () => void local.act(a);
  const open = local.open;
  const [managing, setManaging] = useState(false);
  const { count, shown } = useModelCounts(connection?.provider_id);
  // Its models as an API service's row says them: how many the menu shows, and when they were taken.
  const ready = [
    t("models.state.readyShown", { shown, count }),
    connection?.models_fetched_at ? t("models.manage.updated", { when: agoText(new Date(connection.models_fetched_at), new Date()) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // The state in a few words, and the actions (the first is the way forward).
  const [line, actions, tone]: [string, [string, () => void][], "" | "ok" | "warn"] = (() => {
    if (state === "ready") return [ready, [[t("models.manage.open"), () => setManaging(true)], [t("models.disconnect"), act("disconnect")]], diagnostic ? "warn" : "ok"];
    if (state === "connecting") return [t("models.state.connecting"), [], ""];
    if (state === "needs_login") return [t("models.state.needsLogin", { name }), [[t("models.open", { name }), open], [t("models.reconnect"), act("retry")]], "warn"];
    if (state === "disabled") return [t("models.state.disabled"), [[t("models.reconnect"), act("retry")], [t("models.remove"), act("remove")]], ""];
    if (state) return [t("models.state.trouble"), [[t("models.reconnect"), act("retry")]], "warn"];
    if (!discovery) return [t(local.error ? "models.state.unknown" : "models.state.checking"), local.error ? [[t("models.recheck"), act("scan")]] : [], ""];
    if (discovery.diagnostic) return [t("models.state.trouble"), [[t("models.recheck"), act("scan")]], "warn"];
    if (!discovery.installed) return [t("models.state.missing"), [[t("models.recheck"), act("scan")]], ""];
    if (discovery.login === "missing") return [t("models.state.signedOut"), [[t("models.open", { name }), open], [t("models.recheck"), act("scan")]], "warn"];
    return [t("models.state.found", { version: discovery.version ?? "" }).trim(), [[t("models.connect"), act("connect")]], ""];
  })();
  if (hidden) return null;
  return (
    <>
      <div className="frow mrow" data-testid={`${adapter}-connection`}>
        <SourceAppMark className="mlogo mlogo-qwen" adapter={adapter} />
        <div className="ft">
          <div className="fn">{name}</div>
          <div className={`fdesc ${tone}`}>{line}</div>
        </div>
        {actions.map(([label, run], i) => (
          <button key={label} className={`btn ${i === 0 && (primary ?? !state) ? "primary" : ""}`} disabled={busy || !local.rpc} onClick={run}>
            {label}
          </button>
        ))}
      </div>
      {state === "ready" && local.pending.length > 0 && <details className="frow" style={{ display: "block" }}><summary>{t("models.otherModels", { count: local.pending.length })}</summary>{local.pending.map(model => <div key={model.id} className="fdesc">{model.name} · {t("models.unverified")}</div>)}</details>}
      {diagnostic && (
        <div className="mrow-err" role="status">
          <div>{diagnostic.message}</div>
          <div>{t(`models.diagnostic.actions.${diagnostic.action}`, { defaultValue: t("models.diagnostic.actions.check_details") })}</div>
          <details>
            <summary>{t("models.diagnostic.details")}</summary>
            <div>{t("models.diagnostic.stage")}: {t(`models.diagnostic.stages.${diagnostic.stage}`, { defaultValue: diagnostic.stage })}</div>
            <div>{t("models.diagnostic.code")}: {diagnostic.code}</div>
            {diagnostic.http_status != null && <div>HTTP: {diagnostic.http_status}</div>}
            {diagnostic.field && <div>{t("models.diagnostic.field")}: {diagnostic.field}</div>}
            {discovery?.version && <div>{t("models.diagnostic.version")}: {discovery.version}</div>}
            <div>{t("models.diagnostic.checkedAt")}: {diagnostic.checked_at}</div>
          </details>
          {state === "ready" && <button className="btn" disabled={busy || !local.rpc} onClick={act("retry")}>{t("models.reconnect")}</button>}
          {diagnostic.action === "open_source" && state !== "needs_login" && <button className="btn" disabled={busy} onClick={open}>{t("models.open", { name })}</button>}
          {diagnostic.action === "reconnect_account" && state !== "disabled" && <button className="btn" disabled={busy || !local.rpc} onClick={act("disconnect")}>{t("models.disconnect")}</button>}
        </div>
      )}
      {local.error && !diagnostic && <p className="mrow-err" role="status">{local.error}</p>}
      {managing && connection && (
        <ManageModels
          source={{
            id: connection.provider_id,
            name,
            mark: <SourceAppMark className="mlogo mlogo-qwen" adapter={adapter} />,
            origin: t("models.manage.source.app", { name }),
            fetchedAt: connection.models_fetched_at,
            failure: diagnostic?.message || local.error || undefined,
            refresh: () => local.act("models"),
          }}
          onClose={() => setManaging(false)}
        />
      )}
    </>
  );
}

/**
 * Subscriptions on the first-run page: the rows Settings › Models shows, the
 * ones on this Mac first. The ones not installed fold into one line naming them, so the
 * list grows by no more than that line however many applications FinxWork supports.
 */
export function SubscriptionConnections() {
  const { t } = useTranslation("settings");
  const name = useLocalName();
  const [statuses, setStatuses] = useState<Partial<Record<LocalAdapter, string>>>({});
  const [unfolded, setUnfolded] = useState(false);
  const report = useCallback((adapter: LocalAdapter, status: string) => setStatuses(s => (s[adapter] === status ? s : { ...s, [adapter]: status })), []);
  const missing = localAdapters.filter(a => statuses[a] === "missing");
  const shown = localAdapters.filter(a => statuses[a] !== "missing");
  const row = (adapter: LocalAdapter) => <LocalRow key={adapter} adapter={adapter} hidden={missing.includes(adapter) && !unfolded} onStatus={report} />;
  const names = missing.map(name).join(t("local.listSep"));
  // One list, the fold line keyed among the rows: a row that changes sides moves, it is not made anew.
  return <section aria-label={t("models.subscription")}>
    <div className="connections-section-heading"><h3>{t("models.subscription")}</h3></div>
    <div className="fgroup onb-local">
      <ChatGptConnection />
      {[
        ...shown.map(row),
        missing.length > 0 && (
          <button key="fold" className={`frow onb-fold ${unfolded ? "open" : ""}`} aria-expanded={unfolded} onClick={() => setUnfolded(u => !u)}>
            <span className="onb-fold-marks">{missing.map(a => <SourceAppMark key={a} className="mlogo" adapter={a} />)}</span>
            <span className="ft">{t("local.more", { names })}</span>
            <Icon name="chevR" />
          </button>
        ),
        ...missing.map(row),
      ]}
    </div>
    <TokenPlanConnections />
    <p className="connections-footnote">{t("models.subscriptionNote")}</p>
  </section>;
}
