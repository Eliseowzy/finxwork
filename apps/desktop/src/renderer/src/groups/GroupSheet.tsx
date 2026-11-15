import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "../components";
import { Icon } from "../icons";
import { useLists, useStore } from "../store";
import { Avatar } from "../bots/Avatar";

/**
 * Making a group (bot-group-chat-dev-brief §5, §6.2): its name, the bots that join, and a note
 * for the group's rules. Only this computer's bots for now: another subject's bot needs the
 * confirmation page (the domain its words go to, and what it may see of the time before it
 * joined), which M7 brings.
 */
export function GroupSheet() {
  const st = useStore();
  const { t } = useTranslation("groups");
  const bots = useLists((l) => l.bots);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [history, setHistory] = useState<"none" | "summary" | "recent">("none");
  const [busy, setBusy] = useState(false);
  const canExternal = st.capabilities?.bots_external === true;
  const local = bots.filter((b) => !b.source);
  const external = canExternal ? bots.filter((b) => b.source) : [];
  const chosenExternal = external.filter((b) => members.includes(b.id));
  const close = () => st.set({ groupSheet: null });
  const toggle = (id: string) => setMembers((was) => (was.includes(id) ? was.filter((x) => x !== id) : [...was, id]));
  const ready = name.trim() !== "" && members.length > 0 && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    const ok = await st.run(async () => {
      const made = await st.call("groups/create", {
        name: name.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
        members: members.map((bot_id) => {
          const bot = bots.find((b) => b.id === bot_id);
          return bot?.source ? { bot_id, history } : { bot_id };
        }),
      });
      st.selectGroup(made.id);
    });
    setBusy(false);
    if (ok) close();
  };
  return (
    <Dialog label={t("sheet.title")} width={440} className="gsheet" onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>{t("sheet.title")}</h3>
        <p className="sub">{t("sheet.sub")}</p>
        <label className="bs-name">
          <span>{t("sheet.name")}</span>
          <input
            className="field"
            value={name}
            autoFocus
            maxLength={40}
            placeholder={t("sheet.namePlaceholder")}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="bs-k">{t("sheet.members")}</div>
        {local.length === 0 ? (
          <p className="sub">{t("sheet.noBots")}</p>
        ) : (
          <div className="gmembers" role="group" aria-label={t("sheet.members")}>
            {local.map((b) => (
              <label key={b.id} className={`gmember ${members.includes(b.id) ? "on" : ""}`}>
                <input type="checkbox" checked={members.includes(b.id)} onChange={() => toggle(b.id)} />
                <Avatar spec={b.avatar} name={b.name} size={28} />
                <span>{b.name}</span>
                <span className="gcheck" aria-hidden="true">
                  {members.includes(b.id) && <Icon name="check" className="sm" />}
                </span>
              </label>
            ))}
          </div>
        )}
        {canExternal && external.length > 0 && (
          <>
            <div className="bs-k">{t("sheet.externalMembers")}</div>
            <div className="gmembers" role="group" aria-label={t("sheet.externalMembers")}>
              {external.map((b) => (
                <label key={b.id} className={`gmember ${members.includes(b.id) ? "on" : ""}`} data-external="true">
                  <input type="checkbox" checked={members.includes(b.id)} onChange={() => toggle(b.id)} />
                  <Avatar spec={b.avatar} name={b.name} size={28} />
                  <span>{b.name}</span>
                  <span className="gmember-host mono">{b.source?.host}</span>
                  <span className="gcheck" aria-hidden="true">
                    {members.includes(b.id) && <Icon name="check" className="sm" />}
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
        {chosenExternal.length > 0 && (
          <div className="gconfirm" role="note">
            <p className="gconfirm-h">{t("sheet.confirmTitle")}</p>
            {chosenExternal.map((b) => (
              <p key={b.id} className="gconfirm-line">
                {t("sheet.confirmLine", { name: b.name, host: b.source?.host })}
              </p>
            ))}
            <div className="gconfirm-h">{t("sheet.history")}</div>
            <div className="ghist" role="radiogroup" aria-label={t("sheet.history")}>
              {(["none", "summary", "recent"] as const).map((h) => (
                <label key={h} className={`ghist-i ${history === h ? "on" : ""}`}>
                  <input type="radio" name="group-history" checked={history === h} onChange={() => setHistory(h)} />
                  {t(`sheet.history_${h}`)}
                </label>
              ))}
            </div>
          </div>
        )}
        {!canExternal && <p className="sub gsheet-note">{t("sheet.localOnly")}</p>}
        <label className="bs-name">
          <span>{t("sheet.note")}</span>
          <textarea className="field gnote" rows={3} value={note} placeholder={t("sheet.notePlaceholder")} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="sheet-foot">
          <button type="button" className="link left" onClick={close}>
            {t("sheet.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!ready}>
            {busy ? t("sheet.creating") : t("sheet.create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}