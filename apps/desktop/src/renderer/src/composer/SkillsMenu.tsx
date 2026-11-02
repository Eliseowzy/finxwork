import { useTranslation } from "react-i18next";
import { isMentionable } from "@finx/client";
import type { CommandInfo } from "@finx/protocol";
import { Icon } from "../icons";
import { useStore, type CustomizeView } from "../store";
import { SubMenuItem } from "./Composer";
import { hoverFocus, MenuList } from "./ConnectorsMenu";

// "+" › 技能: browse and manage, a line, then the skills this conversation can use (what `/`
// offers). A click puts the skill in the message as a tag where the caret was, as choosing it
// from `/` does, and closes the menu. Drawn like the connectors' submenu.

export function SkillsItem({ commands, close, onPick }: { commands: CommandInfo[]; close: () => void; onPick: (name: string) => void }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const go = (view: CustomizeView["view"]) => {
    close();
    st.set({ selection: { kind: "customize" }, customize: { tab: "skills", view, detail: null } });
  };
  const skills = commands
    .flatMap((c) => (c.skill && c.name.startsWith("skill:") && isMentionable(c.name.slice("skill:".length)) ? [{ name: c.name.slice("skill:".length), description: c.description }] : []))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <SubMenuItem icon="cube" label={t("composer.skills")} value={String(skills.length)} title={t("composer.skills")} className="cn-sub">
      <button className="mi" role="menuitem" tabIndex={-1} onMouseMove={hoverFocus} onClick={() => go("discover")}>
        <Icon name="search" />
        <span>{t("composer.browseSkills")}</span>
      </button>
      <button className="mi" role="menuitem" tabIndex={-1} onMouseMove={hoverFocus} onClick={() => go("mine")}>
        <Icon name="gear" />
        <span>{t("composer.manageSkills")}</span>
      </button>
      <div className="msep" role="separator" />
      <MenuList>
        {skills.length === 0 && <div className="mi cn-none-row">{t("composer.noSkills")}</div>}
        {skills.map((s) => (
          <button key={s.name} className="mi cn-row" role="menuitem" tabIndex={-1} title={`${s.name}\n${s.description}`} onMouseMove={hoverFocus} onClick={() => (close(), onPick(s.name))}>
            <Icon name="cube" />
            <span className="nm">{s.name}</span>
          </button>
        ))}
      </MenuList>
    </SubMenuItem>
  );
}
