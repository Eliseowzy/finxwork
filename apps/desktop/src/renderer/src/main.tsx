import "./i18n";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { i18n } from "../../shared/i18n";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/composer.css";

createRoot(document.getElementById("root")!).render(
  <I18nextProvider i18n={i18n}>
    <App />
  </I18nextProvider>,
);
