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
  const canExternal = st.capabilities?.bots_external === true;
  const canAdd = bots.filter((b) => (canExternal || !b.source) && !group.members.some((m) => m.bot_id === b.id));
  const [pending, setPending] = useState<string | null>(null);
  const [history, setHistory] = useState<"none" | "summary" | "recent">("none");
  const choose = (botId: string) => {
    if (!botId) return;
    const bot = bots.find((b) => b.id === botId);
    if (bot?.source) {
      setHistory("none");
      setPending(botId);
      return;
    }
    void st.run(() => st.call("groups/add_member", { id: group.id, bot_id: botId }));
  };
  const confirmExternal = async () => {
    if (!pending) return;
    const botId = pending;
    setPending(null);
    await st.run(() => st.call("groups/add_member", { id: group.id, bot_id: botId, history }));
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
      {pending && (
        <Dialog label={t("sheet.confirmTitle")} width={440} onClose={() => setPending(null)}>
          <h3>{t("sheet.confirmTitle")}</h3>
          <p className="gconfirm-line">{t("sheet.confirmLine", { name: bots.find((b) => b.id === pending)?.name, host: bots.find((b) => b.id === pending)?.source?.host })}</p>
          <div className="gconfirm-h">{t("sheet.history")}</div>
          <div className="ghist" role="radiogroup" aria-label={t("sheet.history")}>
            {(["none", "summary", "recent"] as const).map((h) => (
              <label key={h} className={`ghist-i ${history === h ? "on" : ""}`}>
                <input type="radio" name="panel-history" checked={history === h} onChange={() => setHistory(h)} />
                {t(`sheet.history_${h}`)}
              </label>
            ))}
          </div>
          <div className="sheet-foot">
            <button className="btn" onClick={() => setPending(null)}>{t("sheet.cancel")}</button>
            <button className="btn primary" onClick={() => void confirmExternal()}>{t("panel.add")}</button>
          </div>
        </Dialog>
      )}
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
  const bots = useLists((l) => l.bots);
  const host = m.external ? bots.find((b) => b.id === m.bot_id)?.source?.host : undefined;
  return (
    <div className="frow gpanel-member">
      <Avatar spec={m.avatar} name={m.name} size={28} />
      <span className="gpanel-who">
        <span className="gpanel-name">
          {m.name}
          {m.external && <span className="bext" title={t("panel.external")} aria-label={t("panel.external")}><Icon name="globe" /></span>}
        </span>
        <span className="sub">
          {t(`panel.modes.${m.mode}`)}
          {host && <span className="gpanel-host mono"> · {host}</span>}
        </span>
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
      {m.external && (
        <div className="gpanel-ext">
          <p className="set-note">{t("panel.externalNote")}</p>
          <label className="frow gpanel-stateless">
            <span className="fl">{t("panel.stateless")}</span>
            <input
              type="checkbox"
              checked={!!m.stateless}
              onChange={(e) => void st.run(() => st.call("groups/set_member", { id: group.id, bot_id: m.bot_id, stateless: e.target.checked }))}
            />
          </label>
        </div>
      )}
    </div>
  );
}