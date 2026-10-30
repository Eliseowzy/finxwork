import { app } from "electron";
import { resolveLanguage, setLanguage } from "../shared/i18n";
import { preferences } from "./preferences";

// The app's language for this run: the person's choice in Settings ›
// General, or by default the first of the system's preferred languages the
// app has. Chosen once, at start; a new choice needs a restart.

export function chooseLanguage() {
  setLanguage(resolveLanguage(preferences().language, app.getPreferredSystemLanguages()));
}
