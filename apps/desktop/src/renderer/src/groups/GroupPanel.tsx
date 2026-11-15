import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GroupMember, GroupMemberMode, GroupSummary } from "@finx/protocol";
import { Dialog, RenameField } from "../components";
import { useLists, useStore } from "../store";
import { Icon } from "../icons";
import { Avatar } from "../bots/Avatar";
import { MenuButton, MenuItem } from "../composer/Composer";
import { GroupAvatar } from "./GroupAvatar";

/** How a member takes part, as one would say of a person in a group: joins in, or speaks when spoken to. "lazy" is offered only to a member already on it. */
const modes: GroupMemberMode[] = ["normal", "mentions"];

/**
 * A group's settings (bot-group-chat-dev-brief §5): its name and note, how much each member
 * receives, who is in it, a switch for its pin, and deleting it. Another subject's member shows
 * its marker and what every message here means for it; its own settings are M7's.
 */
export function GroupPanel({ group, onClose }: { group: GroupSummary; onClose: () => void }) {
  const { t } = useTranslation("groups");
  const st = useStore();
  const bots = useLists((l) => l.bots);
  const [note, setNote] = useState(group.note ?? "");
  const [deleting, setDeleting] = useState(false);
  const save = (patch: { name?: string; note?: string }) => st.run(() => st.call("groups/update", { id: group.id, ...patch }));
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
  const externals = group.members.some((m) => m.external);
  return (
    <aside className="bgp bpn gpanel" aria-label={t("panel.title")}>
      <div className="bpn-top drag">
        <button className="tb" title={t("panel.close")} aria-label={t("panel.close")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="bpn-body">
        <div className="bpn-hero gpanel-hero">
          <GroupAvatar members={group.members} size={64} />
          <GroupName group={group} />
          <span className="gpanel-count">{t("panel.count", { count: group.members.length })}</span>
        </div>
        <div className="form">
          <section className="fgroup">
            <textarea
              className="gpanel-note"
              rows={2}
              value={note}
              maxLength={2000}
              aria-label={t("panel.note")}
              placeholder={t("panel.notePlaceholder")}
              onChange={(e) => setNote(e.target.value)}
              onBlur={saveNote}
            />
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
          </section>
          <section>
            <h3 className="fhead">
              {t("panel.members")}
              <span className="gpanel-n">{group.members.length}</span>
            </h3>
            <div className="fgroup">
              {group.members.length === 0 && <div className="frow gpanel-empty">{t("panel.empty")}</div>}
              {group.members.map((m) => (
                <MemberRow key={m.bot_id} group={group} m={m} />
              ))}
              {canAdd.length > 0 && (
                <MenuButton
                  className="frow gpanel-add"
                  title={t("panel.add")}
                  label={
                    <>
                      <span className="gpanel-plus" aria-hidden="true">
                        <Icon name="plus" />
                      </span>
                      <span>{t("panel.addBot")}</span>
                    </>
                  }
                >
                  {(close) =>
                    canAdd.map((b) => (
                      <button key={b.id} className="mi gpanel-mi" role="menuitem" onClick={() => (close(), choose(b.id))}>
                        <Avatar spec={b.avatar} name={b.name} size={22} />
                        <span className="gpanel-mi-n">{b.name}</span>
                        {b.source?.host && <span className="gpanel-mi-h mono">{b.source.host}</span>}
                      </button>
                    ))
                  }
                </MenuButton>
              )}
            </div>
            {externals && <p className="set-note">{t("panel.externalNote")}</p>}
          </section>
          <section className="fgroup">
            <button className="frow bpn-end bpn-del gpanel-del" onClick={() => setDeleting(true)}>
              {t("panel.delete")}
            </button>
          </section>
        </div>
      </div>
      {pending && (
        <Dialog label={t("sheet.confirmTitle")} width={440} onClose={() => setPending(null)}>
          <h3>{t("sheet.confirmTitle")}</h3>
          <div className="gconfirm">
            <div className="gconfirm-row">
              <p className="gconfirm-line">{t("sheet.confirmLine", { name: bots.find((b) => b.id === pending)?.name, host: bots.find((b) => b.id === pending)?.source?.host })}</p>
            </div>
            <div className="gconfirm-row gconfirm-hist">
              <span className="gconfirm-k">{t("sheet.history")}</span>
              <div className="ghist" role="radiogroup" aria-label={t("sheet.history")}>
                {(["none", "summary", "recent"] as const).map((h) => (
                  <label key={h} className={`ghist-i ${history === h ? "on" : ""}`}>
                    <input type="radio" name="panel-history" checked={history === h} onChange={() => setHistory(h)} />
                    {t(`sheet.history_${h}`)}
                  </label>
                ))}
              </div>
            </div>
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

/** Its name; a double click makes it a field. ↩ or leaving it keeps what is written, Esc what was there. */
function GroupName({ group }: { group: GroupSummary }) {
  const { t } = useTranslation("groups");
  const st = useStore();
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <RenameField
        initial={group.name}
        className="bpn-rename"
        maxLength={40}
        end={(name) => {
          setEditing(false);
          const v = name?.trim();
          if (v && v !== group.name) void st.run(() => st.call("groups/update", { id: group.id, name: v }));
        }}
      />
    );
  }
  return (
    <h3 className="bpn-name" title={t("panel.nameHint")} onDoubleClick={() => setEditing(true)}>
      {group.name}
    </h3>
  );
}

/** A member: its face, where it lives, how it takes part (a menu), and on hover a way out. Whether another subject's bot needs what came before sent along is found out when it joins (the stateless probe), not asked. */
function MemberRow({ group, m }: { group: GroupSummary; m: GroupMember }) {
  const { t } = useTranslation("groups");
  const st = useStore();
  const bots = useLists((l) => l.bots);
  const host = m.external ? bots.find((b) => b.id === m.bot_id)?.source?.host : undefined;
  const set = (patch: { mode: GroupMemberMode }) => void st.run(() => st.call("groups/set_member", { id: group.id, bot_id: m.bot_id, ...patch }));
  return (
    <div className="gpanel-member">
      <div className="frow gpanel-mrow">
        <span className="gpanel-face">
          <Avatar spec={m.avatar} name={m.name} size={36} />
          {m.external && (
            <span className="bext" title={t("panel.external")} aria-label={t("panel.external")}>
              <Icon name="globe" />
            </span>
          )}
        </span>
        <span className="gpanel-who">
          <span className="gpanel-name">{m.name}</span>
          <span className={`gpanel-sub ${host ? "mono" : ""}`}>{host ?? t("panel.local")}</span>
        </span>
        <MenuButton className="mb gpanel-mode" align="right" below title={t("panel.mode")} label={<><span className="lbl">{t(`panel.modes.${m.mode}`)}</span><Icon name="chevD" /></>}>
          {(close) => (
            <>
              {(m.mode === "lazy" ? [...modes, "lazy" as const] : modes).map((mode) => (
                <MenuItem key={mode} checked={m.mode === mode} label={t(`panel.modes.${mode}`)} desc={t(`panel.modeDesc.${mode}`)} onClick={() => (close(), set({ mode }))} />
              ))}
            </>
          )}
        </MenuButton>
        <button
          className="gpanel-remove"
          title={t("panel.remove")}
          aria-label={`${t("panel.remove")} ${m.name}`}
          onClick={() => void st.run(() => st.call("groups/remove_member", { id: group.id, bot_id: m.bot_id }))}
        >
          <Icon name="minus" />
        </button>
      </div>
    </div>
  );
}
