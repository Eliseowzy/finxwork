import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderSummary } from "@finx/protocol";
import { Dialog } from "../components";
import { errorText, useStore } from "../store";

// Connecting a model service: an API key for one provider, saved by finx in
// its credential store (the keychain on macOS) with auth/set
// (desktop-kernel-integration §8). The page never keeps the key: it goes to
// finx and the field is cleared.

/** The window event that asks for a provider's key (detail: the provider id, or nothing). */
export const keyEvent = "finx-key-setup";

/** Providers that take a key the user can type. */
export function keyProviders(providers: ProviderSummary[]): ProviderSummary[] {
  return providers.filter((p) => p.auth === "api_key");
}

/** No model can run: every provider that needs a key lacks one. */
export function needsKey(st: { models: { models: { available: boolean }[] }; loaded: boolean }): boolean {
  return st.loaded && st.models.models.length > 0 && !st.models.models.some((m) => m.available);
}

/** The form: provider, key, save. `onDone` runs once finx has the key and the model list is fresh. */
export function KeyForm({ provider: initial, onDone, onCancel }: { provider?: string; onDone: () => void; onCancel?: () => void }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const providers = keyProviders(st.models.providers);
  const preferred = initial ?? st.models.defaults?.model.split("/")[0];
  const [provider, setProvider] = useState(() => providers.find((p) => p.id === preferred)?.id ?? providers[0]?.id ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = providers.find((p) => p.id === provider);
  const save = async () => {
    if (!key.trim() || !provider) return;
    setBusy(true);
    setError(null);
    try {
      await st.call("auth/set", { provider, api_key: key.trim() });
      setKey("");
      await st.refreshModels();
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="keyform"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        <span>{t("key.provider")}</span>
        <select className="field" value={provider} onChange={(e) => setProvider(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("key.key")}</span>
        <input
          className="field"
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={key}
          placeholder={current?.key_env?.[0] ? t("key.placeholder", { env: current.key_env[0] }) : ""}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <p className="note">{current?.credential === "env" ? t("key.fromEnv", { env: current.credential_source }) : t("key.where")}</p>
      {error && <p className="err">{error}</p>}
      <div className="sheet-foot">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            {t("key.cancel")}
          </button>
        )}
        <button type="submit" className="btn primary" disabled={busy || !key.trim() || !provider}>
          {busy ? t("key.saving") : t("key.save")}
        </button>
      </div>
    </form>
  );
}

/** The same form in a sheet, opened by `keyEvent` (a model without a key, a task that failed for want of one, settings). */
export function KeySheet() {
  const { t } = useTranslation("session");
  const [provider, setProvider] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const open = (e: Event) => setProvider(((e as CustomEvent).detail as string | undefined) ?? null);
    window.addEventListener(keyEvent, open);
    return () => window.removeEventListener(keyEvent, open);
  }, []);
  if (provider === undefined) return null;
  const close = () => setProvider(undefined);
  return (
    <Dialog label={t("key.title")} width={440} onClose={close}>
      <h3>{t("key.title")}</h3>
      <p className="sub">{t("key.intro")}</p>
      <KeyForm provider={provider ?? undefined} onDone={close} onCancel={close} />
    </Dialog>
  );
}
