import "./i18n";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { i18n } from "../../shared/i18n";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/composer.css";

// A scroller shows its scrollbar while it moves and for a moment after, as macOS overlays do (app.css).
const settle = new WeakMap<Element, number>();
document.addEventListener("scroll", (e) => {
  const el = e.target instanceof Element ? e.target : document.documentElement;
  el.classList.add("scrolling");
  clearTimeout(settle.get(el));
  settle.set(el, window.setTimeout(() => el.classList.remove("scrolling"), 1000));
}, { capture: true, passive: true });

createRoot(document.getElementById("root")!).render(
  <I18nextProvider i18n={i18n}>
    <App />
  </I18nextProvider>,
);
