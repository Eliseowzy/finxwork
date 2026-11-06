import type { BotSummary } from "@finx/protocol";
import { i18n } from "../../../shared/i18n";
import type { Store } from "../store";

// What can be done to a bot (bot-mode-design §6.16). In the list, from a row's ⋯ menu and right-click:
// pin, rename in place, delete. Its name, avatar and model are in its settings panel (BotPanel), delete too.

// Keys made at run time (`things.2`): the typed lookup cannot check them.
const t = i18n.getFixedT(null, "bots") as unknown as (key: string, o?: Record<string, unknown>) => string;

/** How many things, as the person reads it: 两件事, 2 things. */
export function thingsText(n: number): string {
  return n >= 1 && n <= 10 ? t(`things.${n}`) : t("things.many", { count: n });
}

export type BotAction = { id: "pin" | "rename" | "delete"; label: string } | null;

/** A row's items, a null where a separator goes. */
export function rowActions(b: BotSummary): BotAction[] {
  return [{ id: "pin", label: b.pinned ? t("menu.unpin") : t("menu.pin") }, { id: "rename", label: t("menu.rename") }, ...(b.default ? [] : [null, { id: "delete" as const, label: t("menu.delete") }])];
}

export function runBotAction(st: Store, b: BotSummary, id: NonNullable<BotAction>["id"]) {
  switch (id) {
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
          run: async () => {
            await st.call("bots/delete", { bot_id: b.id });
            // Its settings go with it, not over to the bot shown next.
            st.set({ botPanel: false, botRoutines: null });
          },
          done: t("delete.done", { name: b.name }),
        },
      });
  }
}

/** Clearing a bot's chat, from its settings: asked first, and what stays is said (bot-mode-design §6.5.1). */
export function clearBotChat(st: Store, b: BotSummary) {
  st.set({
    sheet: {
      kind: "confirm",
      title: t("clear.title", { name: b.name }),
      message: t("clear.message"),
      button: t("clear.button"),
      run: () => st.call("bots/clear", { bot_id: b.id }),
      done: t("clear.done"),
    },
  });
}

/** The bot's native right-click menu. */
export async function botContextMenu(st: Store, b: BotSummary) {
  const items = rowActions(b).map((a) => (a ? { id: a.id, label: a.label } : { separator: true as const }));
  const id = await window.finx?.popupMenu(items);
  if (id) runBotAction(st, b, id as NonNullable<BotAction>["id"]);
}
