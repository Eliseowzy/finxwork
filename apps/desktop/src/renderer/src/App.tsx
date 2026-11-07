import { MainWindow } from "./MainWindow";
import { SettingsWindow } from "./settings/Settings";
import { FinxProvider } from "./store";

export function App() {
  const settings = location.hash.startsWith("#settings");
  return <FinxProvider>{settings ? <SettingsWindow /> : <MainWindow />}</FinxProvider>;
}
