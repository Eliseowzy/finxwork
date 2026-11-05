import { useTranslation } from "react-i18next";
import type { ThinkingLevel } from "@finx/protocol";
import { MenuButton, ThinkingItems, useModelSwitch } from "../composer/Composer";
import { keyEvent } from "../composer/KeySetup";
import { ModelList } from "../composer/ModelList";
import { thinkingTitle } from "../format";
import { Icon } from "../icons";
import { useStore } from "../store";

/** The model a bot answers with and how hard it thinks, wherever they are set: making it, its first time, its settings. */
export function ModelRows({ model, thinking, below, onModel, onThinking }: {
  model: string | null;
  thinking: ThinkingLevel;
  /** Menus open under the rows (near the top of the window), not over them. */
  below?: boolean;
  onModel: (ref: string) => ThinkingLevel | void;
  onThinking: (l: ThinkingLevel) => void;
}) {
  const { t } = useTranslation("session");
  const st = useStore();
  const { current, levels, title, choose } = useModelSwitch({ model, thinking, models: st.models, onModel });
  return (
    <div className="fgroup bmodel">
      <div className="frow">
        <span className="fl">{t("composer.model")}</span>
        <div className="fv">
          <MenuButton className="mb" align="right" below={below} title={t("composer.model")} label={<><span className="lbl strong">{title}</span><Icon name="chevD" /></>}>
            {(close) => <ModelList models={st.models} current={current} search onPick={(m) => (close(), choose(m.id, m.provider, m.available))} />}
          </MenuButton>
        </div>
      </div>
      {levels.length > 0 && (
        <div className="frow">
          <span className="fl">{t("composer.thinking")}</span>
          <div className="fv">
            <MenuButton className="mb" align="right" below={below} title={t("composer.thinking")} label={<><span className="lbl strong">{thinkingTitle(thinking)}</span><Icon name="chevD" /></>}>
              {(close) => <ThinkingItems thinking={thinking} levels={levels} onThinking={onThinking} close={close} />}
            </MenuButton>
          </div>
        </div>
      )}
    </div>
  );
}

/** Why a model chosen for a bot cannot answer yet, with the way to its key; nothing when it can. */
export function ModelBlocked({ model }: { model: string | null }) {
  const { t } = useTranslation("bots");
  const st = useStore();
  const entry = st.models.models.find((m) => m.id === model);
  if (entry?.available) return null;
  if (!entry) return <p className="set-note bmodel-why">{t("model.none")}</p>;
  return (
    <p className="set-note bmodel-why">
      {t("model.noKey")}{" "}
      <button type="button" className="link" onClick={() => window.dispatchEvent(new CustomEvent(keyEvent, { detail: entry.provider }))}>
        {t("model.addKey")}
      </button>
    </p>
  );
}
