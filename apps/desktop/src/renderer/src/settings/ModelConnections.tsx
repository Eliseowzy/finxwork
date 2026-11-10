import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../icons";
import { useStore } from "../store";
import { ChatGptConnection } from "./ChatGptConnection";
import { LocalRow, localAdapters } from "./LocalApplicationConnection";
import { AddProvider, KeyRow, TokenPlanSection } from "./ProviderConnections";

// Settings › Models: where finx's models come from, as grouped lists in the
// settings window's grouped rows. Each row says only what it is, its state,
// and the one thing to do with it.

export function ModelConnections() {
  const { t } = useTranslation("settings");
  const st = useStore();
  const [adding, setAdding] = useState(false);
  // Providers with a key from somewhere, and every service added by its address (a local one takes
  // no key); local connections are listed above, the built-in keyless Ollama needs nothing.
  const keyed = st.models.providers.filter((p) => p.custom || (!p.plan && !p.id.startsWith("local-") && p.auth === "api_key" && p.credential !== "missing"));
  return (
    <div className="form models">
      <section>
        <h3 className="fhead">{t("models.subscription")}</h3>
        <div className="fgroup">
          <ChatGptConnection />
          {localAdapters.map(adapter => <LocalRow key={adapter} adapter={adapter} />)}
        </div>
        <p className="set-note">{t("models.subscriptionNote")}</p>
      </section>
      <TokenPlanSection />
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
