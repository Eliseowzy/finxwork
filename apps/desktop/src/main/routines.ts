import { app, powerMonitor, powerSaveBlocker } from "electron";
import type { BotSummary } from "@finx/protocol";
import { isolatedRun } from "./build";
import { preferences } from "./preferences";

// What a bot's routines ask of the app (routine-design §7.4, §7.5). Started at login, it brings the
// service back after a restart and can send their notifications, which only this process can do.
// Kept awake, it runs them overnight. Both follow whether any routine is enabled.

/** Which bots have an enabled routine: what the service stays up for too. */
const enabled = new Set<string>();
let blocker: number | null = null;

/** A build that is not packaged cannot be a login item, and one run for tests must not be. */
const canBeLoginItem = () => app.isPackaged && !isolatedRun();

/** Started at login by us: no window comes up with it. */
export function openedAtLogin(): boolean {
  return canBeLoginItem() && app.getLoginItemSettings().wasOpenedAtLogin;
}

/** The app is an item to start at login while a routine needs it, unless the person said no. */
function applyLoginItem() {
  if (!canBeLoginItem()) return;
  const open = enabled.size > 0 && preferences().routinesAtLogin !== false;
  if (app.getLoginItemSettings().openAtLogin !== open) app.setLoginItemSettings({ openAtLogin: open });
}

/** Asleep the Mac runs nothing, but on its battery it is not ours to keep awake (D-427). */
function applyKeepAwake() {
  const want = enabled.size > 0 && preferences().routinesKeepAwake === true && !powerMonitor.isOnBatteryPower();
  if (want && blocker === null) blocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!want && blocker !== null) {
    powerSaveBlocker.stop(blocker);
    blocker = null;
  }
}

/** Applies what the preferences say now. */
export function applyRoutinePreferences() {
  applyLoginItem();
  applyKeepAwake();
}

function follow(bot: BotSummary) {
  if (bot.routines?.some((r) => r.state === "active")) enabled.add(bot.id);
  else enabled.delete(bot.id);
}

/** Follows the bots' rows, as the notifications do. */
export const routineKeeper = {
  botList(list: BotSummary[]) {
    enabled.clear();
    for (const bot of list) follow(bot);
    applyRoutinePreferences();
  },
  botsChanged(changed: BotSummary[], deleted: string[] = []) {
    for (const bot of changed) follow(bot);
    for (const id of deleted) enabled.delete(id);
    applyRoutinePreferences();
  },
};

export function startRoutineKeeper() {
  powerMonitor.on("on-ac", applyKeepAwake);
  powerMonitor.on("on-battery", applyKeepAwake);
}
