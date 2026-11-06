import { targetOf, type Alert, type AlertTarget } from "@finx/client";
import { app, BrowserWindow, Notification, powerMonitor, shell } from "electron";
import fs from "node:fs";
import { i18n } from "../shared/i18n";
import { Notifier } from "./notifier";
import { platform } from "./platform";
import { preferences } from "./preferences";
import { background, mainWindow, showMain } from "./windows";

// System notifications and the Dock's number (docs/desktop/notification-design.md §5): the system's
// side of the notifier. A click opens what the notification is about.
//
// End-to-end tests (FINXWORK_E2E_NOTIFIED=<file>): what would happen is written there, one JSON per
// line, and the app counts as not in front: a system notification cannot be read back, and an
// unsigned build shows none.

const recordTo = process.env.FINXWORK_E2E_NOTIFIED;
const record = (line: unknown) => recordTo && fs.appendFileSync(recordTo, `${JSON.stringify(line)}\n`);

/** Kept until clicked or taken down: a notification collected early loses its click, and leaves Notification Center. */
const showing = new Map<string, { note: Notification; group: string }>();

export function screenLocked(): boolean {
  return powerMonitor.getSystemIdleState(60) === "locked";
}

function inFront(): boolean {
  if (recordTo) return false;
  // Behind the person's work a test's app is never focused, and its notifications would reach them.
  if (background) return true;
  return BrowserWindow.getFocusedWindow() !== null && !screenLocked();
}

function words(n: Alert): { title: string; body: string } {
  switch (n.kind) {
    case "bot_message":
      return { title: n.name, body: n.text || (n.images ? i18n.t("main:notify.image") : n.file ? i18n.t("main:notify.file", { name: n.file }) : "") };
    case "bot_approval":
      return { title: n.name, body: i18n.t("main:notify.approval", { what: n.text }) };
    case "bot_failed":
      return { title: n.name, body: i18n.t("main:notify.botFailed") };
    case "session_approval":
      return { title: n.title || "FinxWork", body: i18n.t("main:notify.sessionWaits") };
    case "session_failed":
      return { title: n.title || "FinxWork", body: i18n.t("main:notify.sessionFailed") };
    case "session_ended":
      return { title: n.title || "FinxWork", body: i18n.t("main:notify.sessionEnded") };
  }
}

/** What a click opens, until the main window's page takes it: the page may not be there yet. */
let openNext: AlertTarget | null = null;

function opened(group: string) {
  openNext = targetOf(group);
  const win = showMain();
  if (openNext) win.webContents.send("open-target");
}

export function takeOpenTarget(): AlertTarget | null {
  const target = openNext;
  openNext = null;
  return target;
}

function show(id: string, group: string, title: string, body: string, sound: boolean) {
  if (recordTo) return record({ id, group, title, body, sound });
  if (!Notification.isSupported()) return;
  const note = new Notification({ id, groupId: group, title, body, silent: !sound });
  showing.set(id, { note, group });
  note.on("close", () => showing.delete(id));
  note.on("failed", (_e, error) => {
    showing.delete(id);
    console.error(`[finxwork] a notification did not show: ${error}`);
  });
  note.on("click", () => {
    showing.delete(id);
    opened(group);
  });
  note.show();
}

export const notifier = new Notifier({
  show: (alert, sound) => {
    const { title, body } = words(alert);
    show(alert.id, alert.group, title, body, sound);
  },
  clear: (ids) => {
    if (recordTo) return record({ clear: ids });
    for (const id of ids) showing.get(id)?.note.close();
    for (const id of ids) showing.delete(id);
    if (process.platform === "darwin") Notification.remove(ids);
  },
  clearGroups: (groups) => {
    if (recordTo) return record({ clearGroups: groups });
    for (const [id, s] of showing) {
      if (!groups.includes(s.group)) continue;
      s.note.close();
      showing.delete(id);
    }
    if (process.platform === "darwin") for (const group of groups) Notification.removeGroup(group);
  },
  setBadge: (count) => {
    if (recordTo) return record({ badge: count });
    app.setBadgeCount(count);
  },
  inFront,
  settings: () => preferences().notifications,
});

/** Settings › Notifications: shows now, in front or not, so the person can see how it looks; the first also asks the system's permission. */
export function testNotification() {
  show("test", "test", i18n.t("main:notify.testTitle"), i18n.t("main:notify.testBody"), preferences().notifications.sound);
}

/** The system's notification settings for this app, where permission is given and the style chosen. */
export function openNotificationSettings() {
  if (platform.id === "mac") void shell.openExternal("x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.finxwork.app");
}

/**
 * Quitting takes the app's notifications out of Notification Center (seen on macOS), so none is
 * left from an earlier run to answer clicks for: the unread counts say what came meanwhile.
 */
export function startNotifications() {
  powerMonitor.on("unlock-screen", () => mainWindow()?.webContents.send("screen-unlocked"));
  if (recordTo) {
    // A click, for a test: what it opens is the file's first line.
    const clicks = `${recordTo}.click`;
    // Called once at the start too, with the file not there yet: reading it then would be an uncaught error, and a dialog.
    fs.watchFile(clicks, { interval: 100, persistent: false }, (now) => {
      if (now.mtimeMs) opened(fs.readFileSync(clicks, "utf8").split("\n")[0]!);
    });
  }
}
