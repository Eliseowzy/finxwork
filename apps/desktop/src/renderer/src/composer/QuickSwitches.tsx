import { useTranslation } from "react-i18next";
import { useDesktopStatus } from "../desktopControl";
import { Icon } from "../icons";
import { useBrowserState } from "../settings/BrowserSettings";
import { useDesktopConfig } from "../settings/DesktopSettings";
import { useSearchSwitch } from "../settings/SearchSettings";
import { errorText, useStore } from "../store";
import { activate, hoverFocus } from "./ConnectorsMenu";

// The "+" menu's switches: web search, browser control and computer use, the same switches as in
// Settings › 联网搜索, Settings › 浏览器 and Settings › 电脑操控, where the rest of their settings are
// (web-search-design §2.3, computer-use-design §4, browser-design §10.1). Each reaches every conversation's next step.
// The menu stays open, as for the connectors. Computer use that cannot work yet says what it
// needs, and a click takes to its settings. Until the config is read a switch cannot be used.

export function QuickSwitches({ close }: { close: () => void }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const browser = useBrowserState();
  const desktop = useDesktopConfig();
  const { status } = useDesktopStatus(desktop.config?.executable);
  const search = useSearchSwitch();
  const say = (work: Promise<unknown>, done: string) => work.then(() => st.show(done)).catch((e) => st.show(errorText(e), undefined, true));

  const searchOn = search.on !== false;
  const toggleSearch = () => {
    if (search.on === null) return;
    void say(search.set(!searchOn), t(searchOn ? "composer.searchOff" : "composer.searchOn"));
  };

  const browserOn = browser.config?.enabled !== false;
  const toggleBrowser = () => {
    if (!browser.config) return;
    void say(browser.write([{ key_path: "browser.enabled", value: !browserOn }]), t(browserOn ? "composer.browserOff" : "composer.browserOn"));
  };

  const unsupported = status?.accessibility === "unsupported";
  const missing = !!status && !unsupported && !status.program;
  const needsGrant = !!status && !unsupported && !missing && status.accessibility !== "granted";
  const computerOn = desktop.config?.enabled !== false;
  const shownOn = computerOn && !missing && !needsGrant;
  const toggleComputer = () => {
    if (!desktop.config) return;
    // Without what it needs, its settings say how to get it.
    if (missing || needsGrant) {
      close();
      return window.finx?.openSettings("desktop");
    }
    void say(desktop.setEnabled(!computerOn), t(computerOn ? "composer.computerOff" : "composer.computerOn"));
  };

  return (
    <>
      <div
        className={`mi cn-row quick ${searchOn ? "" : "off"}`}
        role="menuitemcheckbox"
        aria-checked={searchOn}
        aria-disabled={search.on === null || undefined}
        tabIndex={-1}
        onMouseMove={hoverFocus}
        onClick={toggleSearch}
        onKeyDown={activate(toggleSearch)}
      >
        <Icon name="search" />
        <span className="nm">{t("composer.searchSwitch")}</span>
        <span className={`sw sm ${searchOn ? "on" : ""}`} aria-hidden="true" />
      </div>
      <div
        className={`mi cn-row quick ${browserOn ? "" : "off"}`}
        role="menuitemcheckbox"
        aria-checked={browserOn}
        aria-disabled={!browser.config || undefined}
        tabIndex={-1}
        onMouseMove={hoverFocus}
        onClick={toggleBrowser}
        onKeyDown={activate(toggleBrowser)}
      >
        <Icon name="globe" />
        <span className="nm">{t("composer.browserSwitch")}</span>
        <span className={`sw sm ${browserOn ? "on" : ""}`} aria-hidden="true" />
      </div>
      {!unsupported && (
        <div
          className={`mi cn-row quick ${shownOn ? "" : "off"}`}
          role="menuitemcheckbox"
          aria-checked={shownOn}
          aria-disabled={!desktop.config || undefined}
          tabIndex={-1}
          onMouseMove={hoverFocus}
          onClick={toggleComputer}
          onKeyDown={activate(toggleComputer)}
        >
          <Icon name="laptop" />
          <span className="nm">{t("composer.computerSwitch")}</span>
          {(missing || needsGrant) && <span className="cn-st">{t(missing ? "composer.computerMissing" : "composer.computerGrant")}</span>}
          <span className={`sw sm ${shownOn ? "on" : ""}`} aria-hidden="true" />
        </div>
      )}
    </>
  );
}
