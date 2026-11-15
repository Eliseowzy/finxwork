import i18next from "i18next";
import enBots from "../locales/en/bots.json" with { type: "json" };
import enCommon from "../locales/en/common.json" with { type: "json" };
import enCustomize from "../locales/en/customize.json" with { type: "json" };
import enGroups from "../locales/en/groups.json" with { type: "json" };
import enMain from "../locales/en/main.json" with { type: "json" };
import enSession from "../locales/en/session.json" with { type: "json" };
import enSettings from "../locales/en/settings.json" with { type: "json" };
import zhBots from "../locales/zh-CN/bots.json" with { type: "json" };
import zhCommon from "../locales/zh-CN/common.json" with { type: "json" };
import zhCustomize from "../locales/zh-CN/customize.json" with { type: "json" };
import zhGroups from "../locales/zh-CN/groups.json" with { type: "json" };
import zhMain from "../locales/zh-CN/main.json" with { type: "json" };
import zhSession from "../locales/zh-CN/session.json" with { type: "json" };
import zhSettings from "../locales/zh-CN/settings.json" with { type: "json" };

// The app's text, by namespace: main (the main process: menus, dialogs),
// common (what the window's parts share), session (a session's page),
// customize (the 自定义 page), settings, bots (Bot mode) and groups (Bot mode's groups). English holds every key; zh-CN translates them. The language is
// chosen once per process, before anything shows text (main/language.ts),
// so no text is computed at a module's top level.

export const languages = ["zh-CN", "en"] as const;
export type Language = (typeof languages)[number];

export const resources = {
  en: { main: enMain, common: enCommon, session: enSession, customize: enCustomize, settings: enSettings, bots: enBots, groups: enGroups },
  "zh-CN": { main: zhMain, common: zhCommon, session: zhSession, customize: zhCustomize, settings: zhSettings, bots: zhBots, groups: zhGroups },
} satisfies Record<Language, Record<string, object>>;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: (typeof resources)["en"];
  }
}

export const i18n = i18next.createInstance();
i18n.init({
  lng: "zh-CN",
  fallbackLng: "en",
  supportedLngs: languages,
  resources,
  ns: ["main", "common", "session", "customize", "settings", "bots", "groups"],
  defaultNS: "common",
  initAsync: false,
  interpolation: { escapeValue: false },
});

/** What the person chose in Settings › General › Language: the system's languages, or one of the app's. */
export type LanguageChoice = "system" | Language;

/**
 * The language for the person's preferred languages, most preferred first
 * (BCP 47 tags as the system reports them: "zh-Hans-CN", "en-GB"): the first
 * one the app has, else English. Traditional Chinese doesn't take
 * Simplified Chinese.
 */
export function pickLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const [lang, ...rest] = tag.toLowerCase().replace(/_/g, "-").split("-");
    if (lang === "en") return "en";
    if (lang === "zh") {
      const script = rest.find((s) => s === "hans" || s === "hant");
      if (script === "hans" || (!script && !rest.some((r) => ["tw", "hk", "mo"].includes(r)))) return "zh-CN";
    }
  }
  return "en";
}

/** The language for a choice and the system's preferred languages. */
export function resolveLanguage(choice: LanguageChoice | undefined, preferred: readonly string[]): Language {
  return choice && choice !== "system" && languages.includes(choice) ? choice : pickLanguage(preferred);
}

/** Sets the process's language, once, before anything shows text. */
export function setLanguage(lng: Language) {
  i18n.changeLanguage(lng);
}

/** The current language. */
export function language(): Language {
  return i18n.language as Language;
}
