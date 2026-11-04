import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AuthSetResult, ProviderSummary } from "@finx/protocol";
import { Dialog } from "../components";
import { Icon } from "../icons";
import { errorText, useStore } from "../store";
import { Brand, useTileName } from "./ProviderConnections";
import { ManageModels } from "./ManageModels";
import "../styles/token-plans.css";

const order = ["bailian-token-plan", "tencent-token-plan", "volcengine-agent-plan", "volcengine-coding-plan", "zai-coding-plan", "zhipu-coding-plan"];
const connected = (p: ProviderSummary) => p.credential !== "missing";

/** One compact entry; only configured products become rows outside the picker. */
export function TokenPlanConnections() {
  const { t } = useTranslation("settings");
  const st = useStore();
  const name = useTileName();
  const [dialog, setDialog] = useState<{ id?: string } | null>(null);
  const plans = st.models.providers.filter(p => p.plan && p.auth === "api_key").sort((a, b) => {
    const rank = (id: string) => order.includes(id) ? order.indexOf(id) : order.length;
    return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
  });
  if (!plans.length) return null;
  const added = plans.filter(connected);
  return <>
    {added.length > 0 && <div className="fgroup token-plan-connected">
      {added.map(p => <button key={p.id} className="frow token-plan-row" onClick={() => setDialog({ id: p.id })}>
        <Brand id={p.id} name={name(p)} />
        <span className="ft"><span className="fn">{name(p)}</span><span className="fdesc">
          {p.listing?.error ? t("models.plans.needsAttention") : t("models.plans.added")} · {t("models.count", { count: p.listing?.models ?? st.models.models.filter(m => m.provider === p.id).length })}
        </span></span>
        <Icon name="chevR" />
      </button>)}
    </div>}
    <button className="token-plan-entry" onClick={() => setDialog({})}>
      <span className="token-plan-stack" aria-hidden="true">
        {plans.filter(p => p.id !== "volcengine-coding-plan").slice(0, 5).map(p => <span key={p.id}><Brand id={p.id} name={name(p)} /></span>)}
      </span>
      <span className="token-plan-entry-text"><strong>{t("models.plans.connect")}</strong><span>{t("models.plans.subtitle")}</span></span>
      <Icon name="chevR" />
    </button>
    {dialog && <TokenPlanDialog plans={plans} initialId={dialog.id} onClose={() => setDialog(null)} />}
  </>;
}

function TokenPlanDialog({ plans, initialId, onClose }: { plans: ProviderSummary[]; initialId?: string; onClose: () => void }) {
  const { t } = useTranslation("settings");
  const st = useStore();
  const name = useTileName();
  const [id, setId] = useState(initialId);
  const [view, setView] = useState<"setup" | "manage" | "models" | "saved">(initialId ? "manage" : "setup");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AuthSetResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const p = plans.find(p => p.id === id);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!id || view !== "setup") heading.current?.focus();
  }, [id, view]);
  const pick = (p: ProviderSummary) => { setId(p.id); setView(connected(p) ? "manage" : "setup"); setError(""); setResult(null); setConfirming(false); };
  const back = () => { setId(undefined); setView("setup"); setError(""); setResult(null); setConfirming(false); };
  const remove = async () => {
    if (!p) return;
    setBusy(true); setError("");
    try {
      await st.call("auth/delete", { provider: p.id });
      await st.refreshModels();
      back();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  if (p && view === "models") return <ManageModels source={{
    id: p.id, name: name(p), mark: <Brand id={p.id} />,
    origin: t(p.plan?.dynamic_models ? "models.plans.dynamicCatalog" : "models.plans.seedCatalog"),
    fetchedAt: p.listing?.fetched_at, refreshing: p.listing?.refreshing, failure: p.listing?.error?.message,
    refresh: p.plan?.dynamic_models ? () => st.call("models/refresh", { provider: p.id }) : undefined,
  }} onClose={() => setView("manage")} />;
  return <Dialog label={p ? name(p) : t("models.plans.connect")} width={480} className="token-plan-dialog" onClose={() => { if (!busy) onClose(); }}>
    <div className="token-plan-toolbar">
      {p ? <button className="token-plan-back" disabled={busy} onClick={back}><Icon name="chevL" />{t("models.plans.allPlans")}</button> : <span>{t("models.subscription")}</span>}
      <button className="provider-icon-button" aria-label={t("models.close")} disabled={busy} onClick={onClose}><Icon name="x" /></button>
    </div>
    {!p ? <>
      <div className="token-plan-heading"><h2 ref={heading} tabIndex={-1}>{t("models.plans.choose")}</h2><p>{t("models.plans.chooseNote")}</p></div>
      <div className="token-plan-picker">
        {plans.map(p => <button key={p.id} className="token-plan-option" onClick={() => pick(p)}>
          <span className="token-plan-mark"><Brand id={p.id} name={name(p)} /></span>
          <span className="token-plan-option-text"><strong>{name(p)}</strong><span>{t(`models.plans.products.${p.id}.note`, { defaultValue: "" })}</span></span>
          {connected(p) && <span className="token-plan-badge">{t("models.plans.added")}</span>}
          <Icon name="chevR" />
        </button>)}
      </div>
      <p className="token-plan-picker-note">{t("models.plans.pickerNote")}</p>
    </> : <>
      <div className="token-plan-heading token-plan-product-heading">
        <span className="token-plan-mark"><Brand id={p.id} name={name(p)} /></span>
        <h2 ref={heading} tabIndex={-1}>{name(p)}</h2>
        <p>{t(`models.plans.products.${p.id}.note`, { defaultValue: t("models.plans.subtitle") })}</p>
      </div>
      {view === "setup" ? <PlanKeyForm key={p.id} provider={p} busy={busy} setBusy={setBusy} onSaved={async r => {
        setResult(r); setView("saved");
        try { await st.refreshModels(); } catch (e) { setError(errorText(e)); }
      }} onCancel={() => connected(p) ? setView("manage") : back()} /> : <div className="token-plan-body">
        {view === "saved" && <div className="token-plan-result" role="status">
          <Icon name="check" /><div><strong>{t(result?.verified ? "models.plans.verified" : "models.plans.saved")}</strong>
          <p>{t(result?.verified ? "models.plans.verifiedNote" : "models.plans.unverifiedNote")}</p></div>
        </div>}
        {view === "manage" && <p className="token-plan-status">{t(`models.credential.${p.credential}`, { env: p.credential_source ?? "", defaultValue: "" })}</p>}
        {p.listing?.error && <p className="err" role="alert">{p.listing.error.message}</p>}
        <PlanDetails provider={p} />
        {error && <p className="err" role="alert">{error}</p>}
        <div className="token-plan-actions">
          <button className="btn" disabled={busy} onClick={() => setView("models")}>{t("models.manage.open")}</button>
          {view === "saved" ? <button className="btn primary" disabled={busy} onClick={onClose}>{t("models.plans.done")}</button> : p.credential === "stored" && <button className="btn" disabled={busy} onClick={() => { setConfirming(false); setView("setup"); }}>{t("models.replaceKey")}</button>}
        </div>
        {view === "manage" && (p.credential === "stored" ? <div className="token-plan-remove">
          {confirming ? <><p>{t("models.plans.removeNote")}</p><div className="token-plan-actions"><button className="btn" disabled={busy} onClick={() => setConfirming(false)}>{t("models.cancel")}</button><button className="btn danger" disabled={busy} onClick={() => void remove()}>{t("models.confirmRemove")}</button></div></> : <button className="token-plan-text-button" onClick={() => setConfirming(true)}>{t("models.remove")}</button>}
        </div> : <p className="token-plan-note">{t(`models.elsewhere.${p.credential === "env" ? "env" : "config"}`, { env: p.credential_source ?? "" })}</p>)}
      </div>}
    </>}
  </Dialog>;
}

function PlanDetails({ provider: p }: { provider: ProviderSummary }) {
  const { t } = useTranslation("settings");
  return <details className="token-plan-details"><summary>{t("models.plans.details")}</summary><dl>
    <dt>{t("models.plans.endpoint")}</dt><dd>{p.plan?.base_url}</dd>
    <dt>{t("models.plans.protocol")}</dt><dd>{p.plan?.api === "openai-chat" ? "OpenAI Chat Completions" : p.plan?.api}</dd>
    <dt>{t("models.plans.catalog")}</dt><dd>{t(p.plan?.dynamic_models ? "models.plans.dynamicCatalog" : "models.plans.seedCatalog")}</dd>
  </dl><p>{t("models.plans.catalogNote")}</p></details>;
}

function PlanKeyForm({ provider: p, busy, setBusy, onSaved, onCancel }: { provider: ProviderSummary; busy: boolean; setBusy: (busy: boolean) => void; onSaved: (result: AuthSetResult) => Promise<void>; onCancel: () => void }) {
  const { t } = useTranslation("settings");
  const st = useStore();
  const inputId = useId();
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const save = async () => {
    if (busy || !key.trim()) return;
    setBusy(true); setError("");
    try {
      const result = await st.call("auth/set", { provider: p.id, api_key: key.trim() });
      setKey("");
      await onSaved(result);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return <form className="token-plan-body" onSubmit={e => { e.preventDefault(); void save(); }}>
    <div className="token-plan-key-label"><label htmlFor={inputId}>API Key</label><a href={p.plan?.key_url} target="_blank" rel="noreferrer" onClick={async e => {
      if (window.finx && p.plan) { e.preventDefault(); try { await window.finx.openExternal(p.plan.key_url); } catch (e) { setError(errorText(e)); } }
    }}>{t("models.plans.getKey")}<Icon name="ext" /></a></div>
    <input id={inputId} className="field token-plan-key" type="password" autoComplete="off" autoFocus spellCheck={false} value={key} disabled={busy} placeholder={t("models.plans.keyPlaceholder")} onChange={e => setKey(e.target.value)} />
    <p className="token-plan-note">{t("models.plans.keyNote")}</p>
    <PlanDetails provider={p} />
    {error && <p className="err" role="alert">{error}</p>}
    <div className="token-plan-actions"><button className="btn" type="button" disabled={busy} onClick={onCancel}>{t("models.cancel")}</button><button className="btn primary" type="submit" disabled={busy || !key.trim()}>{t(busy ? "models.plans.saving" : "models.plans.save")}</button></div>
  </form>;
}
