import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AvatarHue, AvatarInput, BotSummary } from "@finx/protocol";
import type { SessionView } from "@finx/client";
import { RenameField } from "../components";
import { MenuButton, PermissionItems, ThinkingItems, useModelSwitch } from "../composer/Composer";
import { ModelList } from "../composer/ModelList";
import { permissionDesc, permissionTitle, thinkingTitle } from "../format";
import { Icon } from "../icons";
import { useStore } from "../store";
import { runBotAction } from "./actions";
import { BotAvatar } from "./Avatar";
import { AvatarChoices, NAME_MAX, pickPicture } from "./BotSheet";

/**
 * A bot's settings (bot-mode-design §6.5.1), opened from its name at the top of its page: its
 * avatar and name, changed where they are; the model it answers with and how hard it thinks; what
 * it may do without asking; deleting it, unless it is the default bot. Beside the conversation, in
 * the place the file panel and the browser take.
 */
export function BotPanel({ bot, view, session, onClose }: { bot: BotSummary; view: SessionView | null; session: string | null; onClose: () => void }) {
  const { t } = useTranslation("bots");
  const st = useStore();
  // The note about Full Access is there to lead here (bot-mode-design §6.13): here, it has done its work.
  useEffect(() => {
    if (!st.botAccessSeen) st.set({ botAccessSeen: true });
  }, []);
  return (
    <aside className="bgp bpn" aria-label={t("head.settings")}>
      <div className="bpn-top drag">
        <button className="tb" title={t("panel.close")} aria-label={t("panel.close")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="bpn-body">
        <BotHero key={bot.id} bot={bot} />
        <div className="form">
          {view && session && <ModelSection view={view} session={session} />}
          {view && session && <PermissionSection view={view} session={session} />}
          {!bot.default && (
            <section className="fgroup">
              <button className="frow bpn-del" onClick={() => runBotAction(st, bot, "delete")}>
                {t("menu.delete")}
              </button>
            </section>
          )}
        </div>
      </div>
    </aside>
  );
}

/** Its avatar, which on hover says it can be changed: a click opens the characters and colours in place, and a choice applies at once. */
function BotHero({ bot }: { bot: BotSummary }) {
  const { t } = useTranslation("bots");
  const st = useStore();
  const [picking, setPicking] = useState(false);
  const spec = bot.avatar;
  const hue: AvatarHue = spec.kind === "char" || spec.kind === "mono" ? spec.hue : "slate";
  const save = (avatar: AvatarInput) => st.run(() => st.call("bots/update", { bot_id: bot.id, avatar }));
  return (
    <div className="bpn-hero">
      <button className="bpn-av" title={t("panel.avatar")} aria-label={t("panel.avatar")} aria-expanded={picking} onClick={() => setPicking(!picking)}>
        <BotAvatar bot={bot} size={72} />
        <span className="bpn-av-edit" aria-hidden="true">
          <Icon name="edit" />
        </span>
      </button>
      <BotName bot={bot} />
      {picking && (
        <div className="fgroup bpn-pick">
          <AvatarChoices avatar={spec} hue={hue} name={bot.name} mark={bot.default} onChoose={(a) => void save(a)} />
          <button
            className="link"
            onClick={async () => {
              const got = await pickPicture();
              if (!got) return;
              if ("error" in got) return st.show(t(got.error === "too_large" ? "sheet.tooLarge" : "sheet.unreadable"), undefined, true);
              await save({ kind: "image", png: got.png });
            }}
          >
            {t("sheet.upload")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Its name; a double click makes it a field. ↩ or leaving it keeps what is written, Esc what was there. */
function BotName({ bot }: { bot: BotSummary }) {
  const { t } = useTranslation("bots");
  const st = useStore();
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <RenameField
        initial={bot.name}
        className="bpn-rename"
        maxLength={NAME_MAX}
        end={(name) => {
          setEditing(false);
          const v = name?.trim();
          if (v && v !== bot.name) void st.run(() => st.call("bots/update", { bot_id: bot.id, name: v }));
        }}
      />
    );
  }
  return (
    <h3 className="bpn-name" title={t("panel.nameHint")} onDoubleClick={() => setEditing(true)}>
      {bot.name}
    </h3>
  );
}

/** The model this bot answers with and how hard it thinks: its conversation's own, as a session's are. */
function ModelSection({ view, session }: { view: SessionView; session: string }) {
  const { t } = useTranslation("bots");
  const { t: ts } = useTranslation("session");
  const st = useStore();
  const { model, thinking } = view.info;
  const onThinking = (l: typeof thinking) => void st.op(session, { type: "set_model", model, thinking: l });
  const { current, levels, title, choose } = useModelSwitch({ model, thinking, models: st.models, onModel: (ref) => void st.op(session, { type: "set_model", model: ref }) });
  return (
    <section>
      <h3 className="fhead">{t("panel.model")}</h3>
      <div className="fgroup">
        <div className="frow">
          <span className="fl">{ts("composer.model")}</span>
          <div className="fv">
            <MenuButton className="mb" align="right" below title={ts("composer.model")} label={<><span className="lbl strong">{title}</span><Icon name="chevD" /></>}>
              {(close) => <ModelList models={st.models} current={current} search onPick={(m) => (close(), choose(m.id, m.provider, m.available))} />}
            </MenuButton>
          </div>
        </div>
        {levels.length > 0 && (
          <div className="frow">
            <span className="fl">{ts("composer.thinking")}</span>
            <div className="fv">
              <MenuButton className="mb" align="right" below title={ts("composer.thinking")} label={<><span className="lbl strong">{thinkingTitle(thinking)}</span><Icon name="chevD" /></>}>
                {(close) => <ThinkingItems thinking={thinking} levels={levels} onThinking={onThinking} close={close} />}
              </MenuButton>
            </div>
          </div>
        )}
      </div>
      <p className="set-note">{t("panel.modelNote")}</p>
    </section>
  );
}

/** What this bot may do without asking: its conversation's permission mode, as a session's is. What it creates follows it (subagent-design §10.4), and the note says so. */
function PermissionSection({ view, session }: { view: SessionView; session: string }) {
  const { t } = useTranslation("bots");
  const { t: ts } = useTranslation("session");
  const st = useStore();
  const mode = view.info.permission_mode;
  return (
    <section className="bpn-perm">
      <h3 className="fhead">{t("panel.permission")}</h3>
      <div className="fgroup">
        <div className="frow">
          <span className="fl">{t("panel.permissionMode")}</span>
          <div className="fv">
            <MenuButton className="mb" align="right" below title={ts("composer.permission")} label={<><span className="lbl strong">{permissionTitle(mode)}</span><Icon name="chevD" /></>}>
              {(close) => <PermissionItems value={mode} onChange={(m) => void st.op(session, { type: "set_permission_mode", mode: m })} close={close} bypassNote={t("panel.bypassNote")} />}
            </MenuButton>
          </div>
        </div>
      </div>
      <p className="set-note">{t("panel.permissionNote", { desc: permissionDesc(mode) })}</p>
    </section>
  );
}
