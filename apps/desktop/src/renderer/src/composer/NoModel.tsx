import { useTranslation } from "react-i18next";
import { MarkMotion } from "../icons";
import { onboardingEvent } from "../onboarding/Onboarding";

/** No model can run (the first-run page was left for later): says so, and the way back to it. */
export function NoModel() {
  const { t } = useTranslation("session");
  return (
    <div className="new-hero">
      <MarkMotion size={72} />
      <h1>{t("new.noModel")}</h1>
      <button className="btn primary" onClick={() => window.dispatchEvent(new Event(onboardingEvent))}>
        {t("new.connect")}
      </button>
    </div>
  );
}
