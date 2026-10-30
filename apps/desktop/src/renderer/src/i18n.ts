import { languages, pickLanguage, setLanguage, type Language } from "../../shared/i18n";

// The page's language: the one the main process chose for this run, or (a
// page previewed in a browser) the browser's. Imported first by main.tsx,
// before any module that shows text. The platform goes on <html> too: it is
// the one place the page's look depends on the OS (styles/tokens.css).
const chosen = window.finx?.language;
const lng: Language = chosen && languages.includes(chosen) ? chosen : pickLanguage(navigator.languages);
setLanguage(lng);
document.documentElement.lang = lng;
document.documentElement.dataset.platform = window.finx?.platform ?? "web";
