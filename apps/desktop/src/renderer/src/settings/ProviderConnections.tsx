import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderSummary } from "@finx/protocol";
import anthropic from "../assets/providers/anthropic.svg?raw";
import deepseek from "../assets/providers/deepseek.svg?raw";
import gemini from "../assets/providers/gemini.svg?raw";
import kimi from "../assets/providers/kimi.svg?raw";
import ollama from "../assets/providers/ollama.svg?raw";
import openai from "../assets/providers/openai.svg?raw";
import openrouter from "../assets/providers/openrouter.svg?raw";
import qwen from "../assets/providers/qwen.svg?raw";
import alibabacloud from "../assets/providers/alibabacloud.svg?raw";
import tencentcloud from "../assets/providers/tencentcloud.svg?raw";
import volcengine from "../assets/providers/volcengine.svg?raw";
import zai from "../assets/providers/zai.svg?raw";
import zhipu from "../assets/providers/zhipu.svg?raw";
import { keyProviders, saveKey } from "../composer/KeySetup";
import { Dialog } from "../components";
import { agoText } from "../format";
import { Icon } from "../icons";
import { errorText, useStore } from "../store";
import { ManageModels, useModelCounts } from "./ManageModels";
import "../styles/connections.css";
import "../styles/providers.css";

// The providers that take an API key: their marks, the tiles to pick one, and the
// form that gives finx its key (auth/set). Used by Settings › Models and the
// first-run page.

/** The providers' own marks (assets/providers/README.md), by provider id. */
const marks: Record<string, string> = { anthropic, deepseek, google: gemini, kimi, ollama, openai, openrouter, qwen, glm: zhipu,
  "bailian-token-plan": alibabacloud, "tencent-token-plan": tencentcloud,
  "volcengine-agent-plan": volcengine, "volcengine-coding-plan": volcengine,
  "zai-coding-plan": zai, "zhipu-coding-plan": zhipu,
};

/** A provider's mark: its own for the known ones (a variant endpoint as its provider), a code glyph for a custom endpoint, else its initial. */
export function Brand({ id: given, name }: { id: string; name?: string }) {
  const id = given === "deepseek-anthropic" ? "deepseek" : given;
  // A mark with gradients names them; each use gets its own names.
  const uid = useId().replace(/[^\w-]/g, "");
  const mark = marks[id];
  if (mark) return <span className={`provider-brand brand-${id}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: mark.replaceAll("__uid__", uid) }} />;
  if (id === "custom") {
    return <span className="provider-brand brand-custom" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none">
      <path d="m11 8-8 8 8 8m10-16 8 8-8 8M18 5l-4 22" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg></span>;
  }
  return <span className={`provider-brand brand-${id} brand-initial`} aria-hidden="true">{(name ?? id).charAt(0).toUpperCase()}</span>;
}

/** Shorter names than the catalog's, for the provider tiles. */
const tileNames: Record<string, { zh?: string; en?: string }> = {
  qwen: { zh: "阿里云百炼", en: "Alibaba Cloud" },
  glm: { zh: "智谱 GLM", en: "Zhipu GLM" },
  kimi: { zh: "Kimi", en: "Kimi" },
};

/** The order the Token Plans are offered in; one not named here comes after them, by name. */
const planOrder = ["bailian-token-plan", "tencent-token-plan", "volcengine-agent-plan", "volcengine-coding-plan", "zai-coding-plan", "zhipu-coding-plan"];
const planRank = (p: ProviderSummary) => (planOrder.includes(p.id) ? planOrder.indexOf(p.id) : planOrder.length);

/** The Token Plans: a provider with product metadata, taking a key of its own. */
function tokenPlans(providers: ProviderSummary[]): ProviderSummary[] {
  return keyProviders(providers)
    .filter((p) => p.plan)
    .sort((a, b) => planRank(a) - planRank(b) || a.name.localeCompare(b.name));
}

/** The providers that take a key, or with `plans` the Token Plans, as tiles; `skip` leaves out ones already set up. */
export function ProviderTiles({ onPick, skip = [], plans }: { onPick: (p: ProviderSummary) => void; skip?: string[]; plans?: boolean }) {
  const { t } = useTranslation("session");
  const { t: settings } = useTranslation("settings");
  const st = useStore();
  const label = useTileName();
  // The Anthropic-compatible DeepSeek endpoint is the same account as DeepSeek: Settings has it.
  const providers = (plans ? tokenPlans(st.models.providers) : keyProviders(st.models.providers).filter((p) => !p.plan && p.id !== "deepseek-anthropic")).filter((p) => !skip.includes(p.id));
  // The catalog lists models for some providers only; the others are found once the key is in.
  const count = (p: ProviderSummary) => st.models.models.filter((m) => m.provider === p.id).length;
  return (
    <div className="provider-tiles">
      {providers.map((p) => {
        // A plan with a key stays in its place and says so; it is managed from its row.
        if (plans && p.credential !== "missing") {
          return (
            <button key={p.id} className={`provider-choice choice-${p.id} added`} disabled>
              <span className="provider-wordmark">
                <Brand id={p.id} name={label(p)} />
                <strong>{label(p)}</strong>
              </span>
              <span className="provider-choice-meta">
                <span className="badge ok">{settings("models.plans.added")}</span>
              </span>
            </button>
          );
        }
        return (
        <button key={p.id} className={`provider-choice choice-${p.id}`} onClick={() => onPick(p)}>
          <span className="provider-wordmark">
            <Brand id={p.id} name={label(p)} />
            <strong>{label(p)}</strong>
          </span>
          <span className="provider-choice-meta">
            <span>{p.plan ? settings(`models.plans.products.${p.id}.note`, { defaultValue: "API Key" }) : count(p) ? t("onboarding.connect.models", { count: count(p) }) : "API Key"}</span>
            <Icon name="chevR" />
          </span>
        </button>
        );
      })}
    </div>
  );
}

/** A provider's key: saved by finx in its credential store (auth/set); the page keeps nothing. */
export function KeyEntry({ provider, onBack, onSaved }: { provider: ProviderSummary; onBack: () => void; onSaved?: (verified: boolean) => void }) {
  const { t } = useTranslation("session");
  const { t: settings } = useTranslation("settings");
  const st = useStore();
  const label = useTileName();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const card = useRef<HTMLFormElement>(null);
  // The page may be scrolled: the form, below the local application's card, comes into view.
  // (Braces: scrollIntoView returns a promise now, which an effect must not return.)
  useEffect(() => {
    void card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  const plan = provider.plan;
  const save = async () => {
    if (busy || !key.trim()) return;
    setBusy(true);
    setError("");
    try {
      const verified = await saveKey(st, provider.id, key.trim(), plan ? settings("models.plans.unverified") : undefined);
      setKey("");
      // Its models become available (the first-run page moves on to "ready").
      await st.refreshModels();
      onSaved?.(verified);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      ref={card}
      className="connection-card key-entry"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="connection-provider">
        <Brand id={provider.id} name={label(provider)} />
        <div className="connection-provider-name">
          <h4>{label(provider)}</h4>
          <p>{plan ? settings(`models.plans.products.${provider.id}.note`, { defaultValue: t("onboarding.key.subtitle") }) : t("onboarding.key.subtitle")}</p>
        </div>
      </div>
      <div className="provider-form">
        <label>
          API Key
          {plan && (
            <a
              href={plan.key_url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                if (!window.finx) return;
                e.preventDefault();
                window.finx.openExternal(plan.key_url);
              }}
            >
              {settings("models.plans.getKey")}
              <Icon name="ext" />
            </a>
          )}
          <input
            className="field"
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={key}
            placeholder={plan ? settings("models.plans.keyPlaceholder") : provider.key_env?.[0] ? t("key.placeholder", { env: provider.key_env[0] }) : ""}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        {provider.credential === "env" && <p className="provider-form-note">{t("key.fromEnv", { env: provider.credential_source })}</p>}
        {plan && <PlanDetails provider={provider} />}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="connection-card-footer">
        <span>
          <Icon name="lock" />
          {t("onboarding.key.where")}
        </span>
        <div className="key-actions">
          <button type="button" className="btn" disabled={busy} onClick={onBack}>
            {t("onboarding.key.back")}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !key.trim()}>
            {busy ? t("key.saving") : t("onboarding.key.save")}
          </button>
        </div>
      </div>
    </form>
  );
}

export function useTileName() {
  const { t, i18n } = useTranslation("settings");
  const zh = i18n.language.startsWith("zh");
  return (p: ProviderSummary) => p.plan ? t(`models.plans.products.${p.id}.name`, { defaultValue: p.name }) : (zh ? tileNames[p.id]?.zh : tileNames[p.id]?.en) ?? p.name;
}

/** A Token Plan's connection: where its requests go, by which protocol, and where its model list comes from. */
function PlanDetails({ provider: p }: { provider: ProviderSummary }) {
  const { t } = useTranslation("settings");
  return (
    <details className="plan-details">
      <summary>
        <Icon name="chevR" />
        {t("models.plans.details")}
      </summary>
      <dl>
        <dt>{t("models.plans.endpoint")}</dt>
        <dd>{p.plan?.base_url}</dd>
        <dt>{t("models.plans.protocol")}</dt>
        <dd>{p.plan?.api === "openai-chat" ? "OpenAI Chat Completions" : p.plan?.api}</dd>
        <dt>{t("models.plans.catalog")}</dt>
        <dd>{t(p.plan?.dynamic_models ? "models.plans.dynamicCatalog" : "models.plans.seedCatalog")}</dd>
      </dl>
      {!p.plan?.dynamic_models && <p>{t("models.plans.catalogNote")}</p>}
    </details>
  );
}

/** A sheet over Settings › Models: its title, the close button, and what it asks. */
function ConnectSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation("settings");
  return (
    <Dialog label={title} width={560} className="models-add" onClose={onClose}>
      <div className="provider-dialog-top">
        <span>{title}</span>
        <button className="provider-icon-button" aria-label={t("models.close")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="models-add-body">{children}</div>
    </Dialog>
  );
}

/** Adding a provider's key, or with `plans` a Token Plan's: pick one, paste its key. */
export function AddProvider({ skip, plans, onClose }: { skip?: string[]; plans?: boolean; onClose: () => void }) {
  const { t } = useTranslation("settings");
  const [provider, setProvider] = useState<ProviderSummary | null>(null);
  return (
    <ConnectSheet title={t(plans ? "models.plans.connect" : "models.add")} onClose={onClose}>
      {provider ? (
        <KeyEntry provider={provider} onBack={() => setProvider(null)} onSaved={onClose} />
      ) : (
        <>
          {plans && <p className="sub">{t("models.plans.chooseNote")}</p>}
          <ProviderTiles onPick={setProvider} skip={skip} plans={plans} />
        </>
      )}
    </ConnectSheet>
  );
}

/** A provider finx has a key for: where the key comes from, how many of its models the menu shows and when its list was asked; its models can be managed, and a key saved here removed (auth/delete). A Token Plan's sheet also says how it connects and takes a new key. */
export function KeyRow({ p }: { p: ProviderSummary }) {
  const { t } = useTranslation("settings");
  const st = useStore();
  const label = useTileName();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState<"models" | "key" | null>(null);
  const listing = p.listing;
  const known = useModelCounts(p.id);
  const source = t(`models.source.${p.credential}`, { env: p.credential_source ?? "", defaultValue: "" });
  const models = t("models.shownOf", { shown: listing?.shown ?? known.shown, count: listing?.models ?? known.count });
  const updated = listing?.refreshing
    ? t("models.manage.refreshing")
    : listing?.fetched_at
      ? t("models.manage.updated", { when: agoText(new Date(listing.fetched_at), new Date()) })
      : "";
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
          <div className="fn">
            {label(p)}
            {p.plan && <span className="badge ok">{t("models.plans.added")}</span>}
          </div>
          <div className="fdesc">{confirming && p.plan ? t("models.plans.removeNote") : [source, models, updated].filter(Boolean).join(" · ")}</div>
          {listing?.error && <div className="fdesc warn">{t("models.manage.failed", { message: listing.error.message })}</div>}
        </div>
        {!confirming && (
          <button className="btn" onClick={() => setSheet("models")}>
            {t("models.manage.open")}
          </button>
        )}
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
      {sheet === "models" && (
        <ManageModels
          source={{
            id: p.id,
            name: label(p),
            mark: <Brand id={p.id} name={label(p)} />,
            origin: p.plan ? t(p.plan.dynamic_models ? "models.plans.dynamicCatalog" : "models.plans.seedCatalog") : listing ? t(`models.manage.source.${listing.source}`) : undefined,
            fetchedAt: listing?.fetched_at,
            refreshing: listing?.refreshing,
            failure: listing?.error?.message,
            // A plan with presets only has no list to ask for.
            refresh: !p.plan || p.plan.dynamic_models ? () => st.call("models/refresh", { provider: p.id }) : undefined,
          }}
          footer={
            p.plan && (
              <div className="mm-foot">
                <PlanDetails provider={p} />
                {p.credential === "stored" && (
                  <button className="btn" onClick={() => setSheet("key")}>
                    {t("models.replaceKey")}
                  </button>
                )}
              </div>
            )
          }
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "key" && (
        <ConnectSheet title={t("models.plans.replaceTitle")} onClose={() => setSheet(null)}>
          <KeyEntry
            provider={p}
            onBack={() => setSheet("models")}
            onSaved={(verified) => {
              setSheet(null);
              if (verified) st.show(t("models.plans.replaced"));
            }}
          />
        </ConnectSheet>
      )}
    </>
  );
}

/**
 * The Token Plans, a section of their own: the ones with a key as rows, then the entry that adds
 * another, its marks the services still on offer (two products of one service show one mark).
 */
export function TokenPlanSection({ firstRun }: { firstRun?: boolean }) {
  const { t } = useTranslation("settings");
  const st = useStore();
  const name = useTileName();
  const [adding, setAdding] = useState(false);
  const plans = tokenPlans(st.models.providers);
  if (!plans.length) return null;
  const added = plans.filter((p) => p.credential !== "missing");
  const left = plans.filter((p) => p.credential === "missing");
  const offered = left.filter((p, i) => left.findIndex((o) => marks[o.id] === marks[p.id]) === i);
  return (
    <section className={firstRun ? "connections-api onb-api" : undefined} aria-label={t("models.plans.title")}>
      {firstRun ? (
        <div className="connections-section-heading">
          <h3>{t("models.plans.title")}</h3>
        </div>
      ) : (
        <h3 className="fhead">{t("models.plans.title")}</h3>
      )}
      {added.length > 0 && (
        <div className={firstRun ? "fgroup onb-local" : "fgroup"}>
          {added.map((p) => (
            <KeyRow key={p.id} p={p} />
          ))}
        </div>
      )}
      {left.length > 0 && (
        <div className="fgroup plan-entry-group">
          <button className="frow plan-entry" onClick={() => setAdding(true)}>
            <span className="plan-marks" aria-hidden="true">
              {offered.map((p) => (
                <span key={p.id} className="plan-mark">
                  <Brand id={p.id} name={name(p)} />
                </span>
              ))}
            </span>
            <span className="ft">
              <span className="fn">{t("models.plans.connect")}</span>
              <span className="fdesc">{t("models.plans.subtitle")}</span>
            </span>
            <Icon name="chevR" />
          </button>
        </div>
      )}
      {adding && <AddProvider plans onClose={() => setAdding(false)} />}
    </section>
  );
}
