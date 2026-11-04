import type { BotSummary } from "@finx/protocol";
import { i18n } from "../../../shared/i18n";
import type { Store } from "../store";

// What can be done to a bot (bot-mode-design §6.16): from its row's ⋯ menu,
// its right-click menu and its page's ⋯ menu, the same items in each.

// Keys made at run time (`things.2`): the typed lookup cannot check them.
const t = i18n.getFixedT(null, "bots") as unknown as (key: string, o?: Record<string, unknown>) => string;

/** How many things, as the person reads it: 两件事, 2 things. */
export function thingsText(n: number): string {
  return n >= 1 && n <= 10 ? t(`things.${n}`) : t("things.many", { count: n });
}

export type BotAction = { id: "edit" | "pin" | "read" | "unread" | "clear" | "delete"; label: string; enabled?: boolean; danger?: boolean; note?: string } | null;

/** The menu's items, a null where a separator goes. The bot on screen has nothing to mark as read. */
export function botActions(b: BotSummary, viewing: boolean): BotAction[] {
  const items: BotAction[] = [
    { id: "edit", label: t("menu.edit") },
    { id: "pin", label: b.pinned ? t("menu.unpin") : t("menu.pin") },
    viewing ? null : (b.unread ?? 0) > 0 ? { id: "read", label: t("menu.read") } : { id: "unread", label: t("menu.unread") },
    null,
    { id: "clear", label: t("menu.clear"), enabled: !!b.session_id || !!b.last },
    { id: "delete", label: t("menu.delete"), enabled: !b.default, danger: true, note: b.default ? t("menu.default") : undefined },
  ];
  return items.filter((x, i, all) => x !== null || (i > 0 && all[i - 1] !== null));
}

export function runBotAction(st: Store, b: BotSummary, id: NonNullable<BotAction>["id"]) {
  switch (id) {
    case "edit":
      return st.set({ botSheet: { kind: "edit", id: b.id } });
    case "pin":
      return void st.run(() => st.call("bots/update", { bot_id: b.id, pinned: !b.pinned }));
    case "read":
    case "unread":
      return void st.run(() => st.call(id === "read" ? "bots/read" : "bots/unread", { bot_id: b.id }));
    case "clear":
      return st.set({
        sheet: {
          kind: "confirm",
          title: t("clear.title", { name: b.name }),
          message: [t("clear.message"), (b.helpers ?? 0) > 0 ? t("clear.working", { things: thingsText(b.helpers ?? 0) }) : ""].filter(Boolean).join(""),
          button: t("clear.button"),
          run: () => st.call("bots/clear", { bot_id: b.id }),
          done: t("clear.done"),
        },
      });
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
export async function botContextMenu(st: Store, b: BotSummary, viewing: boolean) {
  const items = botActions(b, viewing).map((a) => (a ? { id: a.id, label: a.note ? `${a.label} · ${a.note}` : a.label, enabled: a.enabled !== false } : { separator: true as const }));
  const id = await window.finx?.popupMenu(items);
  if (id) runBotAction(st, b, id as NonNullable<BotAction>["id"]);
}
