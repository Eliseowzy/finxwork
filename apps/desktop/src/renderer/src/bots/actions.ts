import type { BotSummary } from "@finx/protocol";
import { i18n } from "../../../shared/i18n";
import type { Store } from "../store";

// What can be done to a bot (bot-mode-design §6.16). In the list, from a row's ⋯ menu and right-click:
// pin, rename in place, delete. On its page, from the ⋯ at the top right: its name and avatar, delete.

// Keys made at run time (`things.2`): the typed lookup cannot check them.
const t = i18n.getFixedT(null, "bots") as unknown as (key: string, o?: Record<string, unknown>) => string;

/** How many things, as the person reads it: 两件事, 2 things. */
export function thingsText(n: number): string {
  return n >= 1 && n <= 10 ? t(`things.${n}`) : t("things.many", { count: n });
}

export type BotAction = { id: "edit" | "pin" | "rename" | "delete"; label: string; enabled?: boolean; danger?: boolean; note?: string } | null;

function deleting(b: BotSummary): BotAction {
  return { id: "delete", label: t("menu.delete"), enabled: !b.default, danger: true, note: b.default ? t("menu.default") : undefined };
}

/** A row's items, a null where a separator goes. */
export function rowActions(b: BotSummary): BotAction[] {
  return [{ id: "pin", label: b.pinned ? t("menu.unpin") : t("menu.pin") }, { id: "rename", label: t("menu.rename") }, null, deleting(b)];
}

/** The page's items. */
export function pageActions(b: BotSummary): BotAction[] {
  return [{ id: "edit", label: t("menu.edit") }, null, deleting(b)];
}

export function runBotAction(st: Store, b: BotSummary, id: NonNullable<BotAction>["id"]) {
  switch (id) {
    case "edit":
      return st.set({ botSheet: { kind: "edit", id: b.id } });
    case "pin":
      return void st.run(() => st.call("bots/update", { bot_id: b.id, pinned: !b.pinned }));
    case "rename":
      return st.set({ renaming: b.id });
    case "delete":
      return st.set({
        sheet: {
          kind: "confirm",
          title: t("delete.title", { name: b.name }),
          message: t("delete.message"),
          button: t("delete.button"),
          run: () => st.call("bots/delete", { bot_id: b.id }),
          done: t("delete.done", { name: b.name }),
        },
      });
  }
}

/** The bot's native right-click menu. */
export async function botContextMenu(st: Store, b: BotSummary) {
  const items = rowActions(b).map((a) => (a ? { id: a.id, label: a.note ? `${a.label} · ${a.note}` : a.label, enabled: a.enabled !== false } : { separator: true as const }));
  const id = await window.finx?.popupMenu(items);
  if (id) runBotAction(st, b, id as NonNullable<BotAction>["id"]);
}
