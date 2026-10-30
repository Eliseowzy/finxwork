import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderSummary } from "@finx/protocol";
import { Icon } from "../icons";
import { errorText, useStore } from "../store";
import { SourceAppMark, useLocalConnection, localAdapters, type LocalAdapter } from "./LocalApplicationConnection";
import { Brand, KeyEntry, ProviderTiles, useTileName } from "./ProviderConnections";

// Settings › Models: where finx's models come from, as two lists in the
// settings window's grouped rows. Each row says only what it is, its state,
// and the one thing to do with it.

export function ModelConnections() {
  const { t } = useTranslation("settings");
  const st = useStore();
  const [adding, setAdding] = useState(false);
  // Providers with a key from somewhere; local connections are listed above, keyless ones (Ollama) need nothing.
  const keyed = st.models.providers.filter((p) => !p.id.startsWith("local-") && p.auth === "api_key" && p.credential !== "missing");
  return (
    <div className="form models">
      <section>
        <h3 className="fhead">{t("models.local")}</h3>
        <div className="fgroup">
          {localAdapters.map(adapter => <LocalRow key={adapter} adapter={adapter} />)}
        </div>
      </section>
      <section>
        <h3 className="fhead">{t("models.api")}</h3>
        <div className="fgroup">
          {keyed.map((p) => (
            <KeyRow key={p.id} p={p} />
          ))}
          <button className="frow mrow-add" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            {t("models.add")}
          </button>
        </div>
      </section>
      {adding && <AddProvider skip={keyed.map((p) => p.id)} onClose={() => setAdding(false)} />}
    </div>
  );
}

/** A local application: its state, and connecting, reconnecting or disconnecting it. */
function LocalRow({ adapter }: { adapter: LocalAdapter }) {
  const { t } = useTranslation("settings");
  const local = useLocalConnection(adapter);
  const name = adapter === "qoder" ? "Qoder" : t("models.qwen");
  const { discovery, connection, busy } = local;
  const state = connection?.state;
  const act = (a: Parameters<typeof local.act>[0]) => () => void local.act(a);
  const open = local.open;
  // The state in a few words, and the actions (the first is the way forward).
  const [line, actions, tone]: [string, [string, () => void][], "" | "ok" | "warn"] = (() => {
    if (state === "ready") return [t("models.state.ready", { count: local.active.length }), [[t("models.disconnect"), act("disconnect")]], "ok"];
    if (state === "connecting") return [t("models.state.connecting"), [], ""];
    if (state === "needs_login") return [t("models.state.needsLogin", { name }), [[t("models.open", { name }), open], [t("models.reconnect"), act("retry")]], "warn"];
    if (state === "disabled") return [t("models.state.disabled"), [[t("models.reconnect"), act("retry")], [t("models.remove"), act("remove")]], ""];
    if (state) return [t("models.state.trouble"), [[t("models.reconnect"), act("retry")]], "warn"];
    if (!discovery) return [t(local.error ? "models.state.unknown" : "models.state.checking"), local.error ? [[t("models.recheck"), act("scan")]] : [], ""];
    if (!discovery.installed) return [t("models.state.missing"), [[t("models.recheck"), act("scan")]], ""];
    if (discovery.login === "missing") return [t("models.state.signedOut"), [[t("models.open", { name }), open], [t("models.recheck"), act("scan")]], "warn"];
    return [t("models.state.found", { version: discovery.version ?? "" }).trim(), [[t("models.connect"), act("connect")]], ""];
  })();
  return (
    <>
      <div className="frow mrow">
        <SourceAppMark className="mlogo mlogo-qwen" adapter={adapter} />
        <div className="ft">
          <div className="fn">{name}</div>
          <div className={`fdesc ${tone}`}>{line}</div>
        </div>
        {actions.map(([label, run], i) => (
          <button key={label} className={`btn ${i === 0 && !state ? "primary" : ""}`} disabled={busy || !local.rpc} onClick={run}>
            {label}
          </button>
        ))}
      </div>
      {state === "ready" && local.pending.length > 0 && <details className="frow" style={{ display: "block" }}><summary>{t("models.otherModels", { count: local.pending.length })}</summary>{local.pending.map(model => <div key={model.id} className="fdesc">{model.name} · {t("models.unverified")}</div>)}</details>}
      {local.error && discovery && <p className="mrow-err">{local.error}</p>}
    </>
  );
}

/** A provider finx has a key for: where the key comes from and how many models; a key saved here can be removed (auth/delete). */
function KeyRow({ p }: { p: ProviderSummary }) {
  const { t } = useTranslation("settings");
  const st = useStore();
  const label = useTileName();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const count = st.models.models.filter((m) => m.provider === p.id).length;
  const source = t(`models.source.${p.credential}`, { env: p.credential_source ?? "", defaultValue: "" });
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await st.call("auth/delete", { provider: p.id });
      await st.refreshModels();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <>
      <div className="frow mrow">
        <Brand id={p.id} name={label(p)} />
        <div className="ft">
          <div className="fn">{label(p)}</div>
          <div className="fdesc">{[source, t("models.count", { count })].filter(Boolean).join(" · ")}</div>
        </div>
        {p.credential === "stored" ? (
          confirming ? (
            <>
              <button className="btn" disabled={busy} onClick={() => setConfirming(false)}>
                {t("models.cancel")}
              </button>
              <button className="btn primary danger" disabled={busy} onClick={() => void remove()}>
                {t("models.confirmRemove")}
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setConfirming(true)}>
              {t("models.remove")}
            </button>
          )
        ) : (
          // Set outside the app: removed where it is set.
          <span className="fv-side" title={t(`models.elsewhere.${p.credential === "env" ? "env" : "config"}`, { env: p.credential_source ?? "" })}>
            <Icon name="lock" />
          </span>
        )}
      </div>
      {error && <p className="mrow-err">{error}</p>}
    </>
  );
}

/** Adding a provider's key: pick a provider, paste its key. */
function AddProvider({ skip, onClose }: { skip: string[]; onClose: () => void }) {
  const { t } = useTranslation("settings");
  const [provider, setProvider] = useState<ProviderSummary | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog ref={dialog} className="provider-dialog models-add" aria-label={t("models.add")} onCancel={(e) => (e.preventDefault(), onClose())}>
      <div className="provider-dialog-top">
        <span>{t("models.add")}</span>
        <button className="provider-icon-button" aria-label={t("models.close")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="models-add-body">
        {provider ? <KeyEntry provider={provider} onBack={() => setProvider(null)} onSaved={onClose} /> : <ProviderTiles onPick={setProvider} skip={skip} />}
      </div>
    </dialog>
  );
}
