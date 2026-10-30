import { useEffect } from "react";
import { MainWindow } from "./MainWindow";
import { SettingsWindow } from "./settings/Settings";
import { FinxProvider } from "./store";

export function App() {
  const settings = location.hash.startsWith("#settings");
  useVibrancy();
  return <FinxProvider>{settings ? <SettingsWindow /> : <MainWindow />}</FinxProvider>;
}

/** On macOS the window's sidebar material shows through the sidebar; the rest stays opaque. */
function useVibrancy() {
  useEffect(() => {
    if (window.finx?.platform !== "mac") return;
    document.documentElement.classList.add("vibrant");
    return () => document.documentElement.classList.remove("vibrant");
  }, []);
}
