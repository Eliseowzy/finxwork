import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GroupMember, GroupMemberMode, GroupSummary } from "@finx/protocol";
import { Dialog } from "../components";
import { useLists, useStore } from "../store";
import { Icon } from "../icons";
import { Avatar } from "../bots/Avatar";

const modes: GroupMemberMode[] = ["mentions", "normal", "lazy"];

/**
 * A group's settings (bot-group-chat-dev-brief §5): its name and note, how much each member
 * receives, who is in it, a switch for its pin, and deleting it. Another subject's member shows
 * its marker and what every message here means for it; its own settings are M7's.
 */
export function GroupPanel({ group, onClose }: { group: GroupSummary; onClose: () => void }) {
  const { t } = useTranslation("groups");
  const st = useStore();
  const bots = useLists((l) => l.bots);
  const [name, setName] = useState(group.name);
  const [note, setNote] = useState(group.note ?? "");
  const [deleting, setDeleting] = useState(false);
  const save = (patch: { name?: string; note?: string }) => st.run(() => st.call("groups/update", { id: group.id, ...patch }));
  const saveName = () => {
    const n = name.trim();
    if (!n || n === group.name) return setName(group.name);
    void save({ name: n });
  };
  const saveNote = () => {
    if (note.trim() === (group.note ?? "")) return;
    void save({ note });
  };
  const canAdd = bots.filter((b) => !b.source && !group.members.some((m) => m.bot_id === b.id));
  const choose = (botId: string) => {
    if (!botId) return;
    void st.run(() => st.call("groups/add_member", { id: group.id, bot_id: botId }));
  };
  const remove = () => {
    setDeleting(false);
    void st.run(async () => {
      await st.call("groups/delete", { id: group.id });
      st.set({ selection: { kind: "new" }, lastGroup: null, groupPanel: false, groupThread: null });
    });
  };
  return (
    <aside className="bgp bpn gpanel" aria-label={t("panel.title")}>
      <div className="bpn-top drag">
        <button className="tb" title={t("panel.close")} aria-label={t("panel.close")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="bpn-body">
        <div className="form">
          <section>
            <h3 className="fhead">{t("panel.title")}</h3>
            <div className="fgroup">
              <div className="frow gpanel-field">
                <span className="fl">{t("panel.name")}</span>
                <input className="field" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), saveName())} />
              </div>
              <div className="frow gpanel-field">
                <span className="fl">{t("panel.note")}</span>
                <textarea className="field gnote" rows={3} value={note} maxLength={2000} placeholder={t("panel.notePlaceholder")} onChange={(e) => setNote(e.target.value)} onBlur={saveNote} />
              </div>
              <div className="frow">
                <span className="fl">{t("panel.pinned")}</span>
                <div className="fv">
                  <button
                    className={`sw ${group.pinned ? "on" : ""}`}
                    role="switch"
                    aria-checked={!!group.pinned}
                    aria-label={t("panel.pinned")}
                    onClick={() => void st.run(() => st.call("groups/update", { id: group.id, pinned: !group.pinned }))}
                  />
                </div>
              </div>
            </div>
          </section>
          <section>
            <h3 className="fhead">{t("panel.members")}</h3>
            <div className="fgroup">
              {group.members.length === 0 && <p className="set-note">{t("panel.empty")}</p>}
              {group.members.map((m) => (
                <MemberRow key={m.bot_id} group={group} m={m} />
              ))}
            </div>
            {canAdd.length > 0 && (
              <div className="fgroup gpanel-add">
                <label className="frow">
                  <span className="fl">{t("panel.add")}</span>
                  <select className="field" defaultValue="" onChange={(e) => (choose(e.target.value), (e.target.value = ""))}>
                    <option value="" disabled>
                      {t("panel.addPlaceholder")}
                    </option>
                    {canAdd.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </section>
          <section className="fgroup">
            <button className="frow bpn-end bpn-del" onClick={() => setDeleting(true)}>
              {t("panel.delete")}
            </button>
          </section>
        </div>
      </div>
      {deleting && (
        <Dialog label={t("panel.deleteTitle")} width={420} onClose={() => setDeleting(false)}>
          <h3>{t("panel.deleteTitle")}</h3>
          <p className="sub">{t("panel.deleteBody")}</p>
          <div className="sheet-foot">
            <button className="btn" onClick={() => setDeleting(false)}>
              {t("panel.deleteCancel")}
            </button>
            <button className="btn danger" onClick={remove}>
              {t("panel.deleteConfirm")}
            </button>
          </div>
        </Dialog>
      )}
    </aside>
  );
}

function MemberRow({ group, m }: { group: GroupSummary; m: GroupMember }) {
  const { t } = useTranslation("groups");
  const st = useStore();
  return (
    <div className="frow gpanel-member">
      <Avatar spec={m.avatar} name={m.name} size={28} />
      <span className="gpanel-who">
        <span className="gpanel-name">
          {m.name}
          {m.external && <span className="bext" title={t("panel.external")} aria-label={t("panel.external")}><Icon name="globe" /></span>}
        </span>
        <span className="sub">{t(`panel.modes.${m.mode}`)}</span>
      </span>
      <div className="gpanel-modes" role="group" aria-label={t("panel.mode")}>
        {modes.map((mode) => (
          <button
            key={mode}
            className={`gmode ${m.mode === mode ? "on" : ""}`}
            aria-pressed={m.mode === mode}
            onClick={() => void st.run(() => st.call("groups/set_member", { id: group.id, bot_id: m.bot_id, mode }))}
          >
            {t(`panel.modes.${mode}`)}
          </button>
        ))}
      </div>
      <button className="link gpanel-remove" onClick={() => void st.run(() => st.call("groups/remove_member", { id: group.id, bot_id: m.bot_id }))}>
        {t("panel.remove")}
      </button>
      {m.external && <p className="set-note gpanel-ext">{t("panel.externalNote")}</p>}
    </div>
  );
}