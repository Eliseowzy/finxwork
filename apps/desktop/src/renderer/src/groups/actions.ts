import type { GroupSummary } from "@finx/protocol";
import { i18n } from "../../../shared/i18n";
import type { Store } from "../store";

// What can be done to a group from its row in the list, as to a bot's (bots/actions.ts): pin,
// rename in place, delete. Its settings panel (GroupPanel) has the same and more.

const t = i18n.getFixedT(null, "groups") as unknown as (key: string, o?: Record<string, unknown>) => string;

type GroupAction = "pin" | "rename" | "delete";

export function runGroupAction(st: Store, g: GroupSummary, id: GroupAction) {
  switch (id) {
    case "pin":
      return void st.run(() => st.call("groups/update", { id: g.id, pinned: !g.pinned }));
    case "rename":
      return st.set({ renaming: g.id });
    case "delete":
      return st.set({
        sheet: {
          kind: "confirm",
          title: t("panel.deleteTitle"),
          message: t("panel.deleteBody"),
          button: t("panel.deleteConfirm"),
          run: async () => {
            await st.call("groups/delete", { id: g.id });
            // Shown or last opened, it goes from there too, with its panel and thread.
            if ((st.selection.kind === "group" && st.selection.id === g.id) || st.lastGroup === g.id) {
              st.set({ selection: { kind: "new" }, lastGroup: null, groupPanel: false, groupThread: null });
            }
          },
        },
      });
  }
}

/** The group's native right-click menu. */
export async function groupContextMenu(st: Store, g: GroupSummary) {
  const items = [
    { id: "pin", label: g.pinned ? t("menu.unpin") : t("menu.pin") },
    { id: "rename", label: t("menu.rename") },
    { separator: true as const },
    { id: "delete", label: t("menu.delete") },
  ];
  const id = await window.finx?.popupMenu(items);
  if (id) runGroupAction(st, g, id as GroupAction);
}
