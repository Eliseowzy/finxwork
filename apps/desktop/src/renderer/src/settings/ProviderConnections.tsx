import { useEffect, useId, useRef, useState } from "react";
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
import zhipu from "../assets/providers/zhipu.svg?raw";
import { keyProviders, saveKey } from "../composer/KeySetup";
import { Icon } from "../icons";
import { errorText, useStore } from "../store";
import "../styles/connections.css";
import "../styles/providers.css";

// The providers that take an API key: their marks, the tiles to pick one, and the
// form that gives finx its key (auth/set). Used by Settings › Models and the
// first-run page.

/** The providers' own marks (assets/providers/README.md), by provider id. */
const marks: Record<string, string> = { anthropic, deepseek, google: gemini, kimi, ollama, openai, openrouter, qwen, glm: zhipu };

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

/** The providers that take a key, as tiles; `skip` leaves out ones already set up. */
export function ProviderTiles({ onPick, skip = [] }: { onPick: (p: ProviderSummary) => void; skip?: string[] }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const label = useTileName();
  // The Anthropic-compatible DeepSeek endpoint is the same account as DeepSeek: Settings has it.
  const providers = keyProviders(st.models.providers).filter((p) => p.id !== "deepseek-anthropic" && !skip.includes(p.id));
  // The catalog lists models for some providers only; the others are found once the key is in.
  const count = (p: ProviderSummary) => st.models.models.filter((m) => m.provider === p.id).length;
  return (
    <div className="provider-tiles">
      {providers.map((p) => (
        <button key={p.id} className={`provider-choice choice-${p.id}`} onClick={() => onPick(p)}>
          <span className="provider-wordmark">
            <Brand id={p.id} name={label(p)} />
            <strong>{label(p)}</strong>
          </span>
          <span className="provider-choice-meta">
            <span>{count(p) ? t("onboarding.connect.models", { count: count(p) }) : "API Key"}</span>
            <Icon name="chevR" />
          </span>
        </button>
      ))}
    </div>
  );
}

/** A provider's key: saved by finx in its credential store (auth/set); the page keeps nothing. */
export function KeyEntry({ provider, onBack, onSaved }: { provider: ProviderSummary; onBack: () => void; onSaved?: () => void }) {
  const { t } = useTranslation("session");
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
  const save = async () => {
    if (!key.trim()) return;
    setBusy(true);
    setError("");
    try {
      await saveKey(st, provider.id, key.trim());
      setKey("");
      // Its models become available (the first-run page moves on to "ready").
      await st.refreshModels();
      onSaved?.();
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
          <p>{t("onboarding.key.subtitle")}</p>
        </div>
      </div>
      <div className="provider-form">
        <label>
          API Key
          <input
            className="field"
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={key}
            placeholder={provider.key_env?.[0] ? t("key.placeholder", { env: provider.key_env[0] }) : ""}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        {provider.credential === "env" && <p className="provider-form-note">{t("key.fromEnv", { env: provider.credential_source })}</p>}
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
          <button type="button" className="btn" onClick={onBack}>
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
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  return (p: ProviderSummary) => (zh ? tileNames[p.id]?.zh : tileNames[p.id]?.en) ?? p.name;
}
