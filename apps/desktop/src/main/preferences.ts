import { app, nativeTheme } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Appearance, Preferences } from "../shared/bridge";

// The app's own preferences (appearance, language), kept by the main process
// in the app's profile: finx's settings stay finx's (~/.finx).

const defaults: Preferences = { appearance: "system", language: "system" };
const file = () => path.join(app.getPath("userData"), "preferences.json");

let cached: Preferences | undefined;

export function preferences(): Preferences {
  if (cached) return cached;
  try {
    const p = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<Preferences>;
    cached = {
      appearance: (["system", "light", "dark"] as Appearance[]).includes(p.appearance as Appearance) ? (p.appearance as Appearance) : defaults.appearance,
      language: p.language === "en" || p.language === "zh-CN" ? p.language : "system",
      ...(p.moveDeclined === true && { moveDeclined: true }),
      ...(p.browserCookies === "untilQuit" && { browserCookies: "untilQuit" as const }),
    };
  } catch {
    cached = { ...defaults };
  }
  return cached;
}

export function setPreferences(p: Partial<Preferences>): Preferences {
  const next = { ...preferences() };
  if (p.appearance === "system" || p.appearance === "light" || p.appearance === "dark") next.appearance = p.appearance;
  if (p.language === "system" || p.language === "en" || p.language === "zh-CN") next.language = p.language;
  if (p.moveDeclined === true) next.moveDeclined = true;
  if ("browserCookies" in p) {
    if (p.browserCookies === "untilQuit") next.browserCookies = "untilQuit";
    else delete next.browserCookies;
  }
  cached = next;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  applyAppearance();
  return next;
}

/** Light, dark or the system's: every window's prefers-color-scheme follows. */
export function applyAppearance() {
  nativeTheme.themeSource = preferences().appearance;
}
