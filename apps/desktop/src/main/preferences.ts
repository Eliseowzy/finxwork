import { app, nativeTheme } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Appearance, NotificationSettings, Preferences } from "../shared/bridge";
import { allEngines, defaultSearchEngine, savedEngines } from "../shared/search";

// The app's own preferences (appearance, language), kept by the main process
// in the app's profile: finx's settings stay finx's (~/.finx).

const defaultNotifications: NotificationSettings = { enabled: true, sound: true, sessionEnded: true };
const defaults: Preferences = { appearance: "system", language: "system", searchEngine: defaultSearchEngine, searchEngines: [], notifications: defaultNotifications };

/** Each setting if it is one, else what it was. */
const notificationsFrom = (p: unknown, base: NotificationSettings): NotificationSettings => {
  const v = (typeof p === "object" && p !== null ? p : {}) as Partial<Record<keyof NotificationSettings, unknown>>;
  const flag = (key: keyof NotificationSettings) => (typeof v[key] === "boolean" ? (v[key] as boolean) : base[key]);
  return { enabled: flag("enabled"), sound: flag("sound"), sessionEnded: flag("sessionEnded") };
};

/** The default engine, if it is still one of the engines; else the app's default. */
const engineIn = (id: unknown, custom: Preferences["searchEngines"]) =>
  typeof id === "string" && allEngines(custom).some((e) => e.id === id) ? id : defaultSearchEngine;
const file = () => path.join(app.getPath("userData"), "preferences.json");

let cached: Preferences | undefined;

export function preferences(): Preferences {
  if (cached) return cached;
  try {
    const p = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<Preferences>;
    cached = {
      appearance: (["system", "light", "gray", "black"] as Appearance[]).includes(p.appearance as Appearance) ? (p.appearance as Appearance) : defaults.appearance,
      language: p.language === "en" || p.language === "zh-CN" ? p.language : "system",
      searchEngines: savedEngines(p.searchEngines),
      searchEngine: engineIn(p.searchEngine, savedEngines(p.searchEngines)),
      notifications: notificationsFrom(p.notifications, defaultNotifications),
      ...(p.moveDeclined === true && { moveDeclined: true }),
      ...(p.browserCookies === "untilQuit" && { browserCookies: "untilQuit" as const }),
      ...(p.routinesAtLogin === false && { routinesAtLogin: false }),
      ...(p.routinesKeepAwake === true && { routinesKeepAwake: true }),
    };
  } catch {
    cached = { ...defaults };
  }
  return cached;
}

export function setPreferences(p: Partial<Preferences>): Preferences {
  const next = { ...preferences() };
  if (p.appearance === "system" || p.appearance === "light" || p.appearance === "gray" || p.appearance === "black") next.appearance = p.appearance;
  if (p.language === "system" || p.language === "en" || p.language === "zh-CN") next.language = p.language;
  if (p.moveDeclined === true) next.moveDeclined = true;
  if ("notifications" in p) next.notifications = notificationsFrom(p.notifications, next.notifications);
  // The person's engines are checked as a saved file is: nothing invalid is kept.
  if ("searchEngines" in p) next.searchEngines = savedEngines(p.searchEngines);
  if ("searchEngine" in p || "searchEngines" in p) next.searchEngine = engineIn(p.searchEngine ?? next.searchEngine, next.searchEngines);
  if ("browserCookies" in p) {
    if (p.browserCookies === "untilQuit") next.browserCookies = "untilQuit";
    else delete next.browserCookies;
  }
  if ("routinesAtLogin" in p) {
    if (p.routinesAtLogin === false) next.routinesAtLogin = false;
    else delete next.routinesAtLogin;
  }
  if ("routinesKeepAwake" in p) {
    if (p.routinesKeepAwake === true) next.routinesKeepAwake = true;
    else delete next.routinesKeepAwake;
  }
  cached = next;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  applyAppearance();
  return next;
}

/** Light, dark or the system's: every window's prefers-color-scheme follows. */
export function applyAppearance() {
  const appearance = preferences().appearance;
  nativeTheme.themeSource = appearance === "gray" || appearance === "black" ? "dark" : appearance;
}
