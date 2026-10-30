import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderSummary } from "@finx/protocol";
import markOnDark from "../../../../../../assets/brand/app/finxwork-mark-on-dark-640.png";
import { Icon } from "../icons";
import { LocalApplicationConnection } from "../settings/LocalApplicationConnection";
import { KeyEntry, ProviderTiles } from "../settings/ProviderConnections";
import { useStore } from "../store";
import "../styles/connections.css";
import "../styles/providers.css";
import "../styles/onboarding.css";

// The first-run page (desktop-kernel-integration §8.4): the whole window, shown
// at launch while no model can run. The brand on the left; on the right the two
// ways to a model as Settings › Models shows them (the local applications' rows,
// the ones on this Mac first, and the providers that take a key), then "ready"
// once a model can run. Leaving it, by starting or by "later", is the person's choice.

/** The window event that opens the first-run page again (the new session page sends it while no model can run). */
export const onboardingEvent = "finx-onboarding";

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const ready = st.models.models.some((m) => m.available);
  return (
    <div className="onb">
      <aside className="onb-brand drag">
        <div className="onb-glow" aria-hidden="true" />
        <img className="onb-mark" src={markOnDark} alt="" draggable={false} />
        <div className="onb-copy">
          <span className="onb-kicker">FINXWORK</span>
          <h1>{t("onboarding.title")}</h1>
          <p>{t("onboarding.tagline")}</p>
        </div>
        <ol className="onb-steps">
          <li className={ready ? "done" : "on"}>
            <i>{ready ? <Icon name="check" /> : 1}</i>
            {t("onboarding.steps.connect")}
          </li>
          <li className={ready ? "on" : ""}>
            <i>2</i>
            {t("onboarding.steps.start")}
          </li>
        </ol>
      </aside>
      <main className="onb-main">
        <div className="onb-top drag" />
        <div className="onb-scroll">
          <div className="connections onb-body">{ready ? <Ready onDone={onDone} /> : <Connect />}</div>
        </div>
        {!ready && (
          <footer className="onb-foot">
            <button className="link" onClick={onDone}>
              {t("onboarding.later")}
            </button>
          </footer>
        )}
      </main>
    </div>
  );
}

/** Step 1: the local application's login, or a provider's key. */
function Connect() {
  const { t } = useTranslation("session");
  const [provider, setProvider] = useState<ProviderSummary | null>(null);
  return (
    <>
      <header className="connections-intro">
        <span className="connections-eyebrow">{t("onboarding.connect.eyebrow")}</span>
        <h2>{t("onboarding.connect.title")}</h2>
        <p>{t("onboarding.connect.intro")}</p>
      </header>
      <LocalApplicationConnection />
      <section className="connections-api onb-api" aria-labelledby="onb-api-heading">
        <div className="connections-section-heading">
          <div>
            <h3 id="onb-api-heading">{t("onboarding.connect.api")}</h3>
            <p>{t("onboarding.connect.apiNote")}</p>
          </div>
        </div>
        {provider ? <KeyEntry provider={provider} onBack={() => setProvider(null)} /> : <ProviderTiles onPick={setProvider} />}
      </section>
    </>
  );
}

/** Step 2: what can run now, and into the app. */
function Ready({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const available = st.models.models.filter((m) => m.available);
  const preferred = st.models.defaults?.model;
  const chosen = available.find((m) => m.id === preferred) ?? available[0];
  const providers = new Map(st.models.providers.map((p) => [p.id, p.name]));
  return (
    <>
      <header className="connections-intro">
        <span className="connections-eyebrow">{t("onboarding.ready.eyebrow")}</span>
        <h2>{t("onboarding.ready.title")}</h2>
        <p>{t("onboarding.ready.intro", { count: available.length, model: chosen?.name ?? "" })}</p>
      </header>
      <article className="connection-card">
        <div className="connection-summary">
          <Icon name="check" />
          <span>{t("onboarding.ready.active", { count: available.length })}</span>
        </div>
        <div className="connection-models">
          {available.slice(0, 6).map((m) => (
            <div className="connection-model" key={m.id}>
              <span>
                <strong>{m.name}</strong>
                <small>{providers.get(m.provider) ?? m.provider}</small>
              </span>
              {m.id === chosen?.id && (
                <span className="connection-default chosen">
                  <Icon name="check" />
                  {t("onboarding.ready.default")}
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="connection-card-footer">
          <span>{t("onboarding.ready.manage")}</span>
          <button className="btn primary onb-start" autoFocus onClick={onDone}>
            {t("onboarding.ready.start")}
            <Icon name="arrowUp" className="onb-arrow" />
          </button>
        </div>
      </article>
    </>
  );
}
