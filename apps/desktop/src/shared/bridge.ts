import type { Language, LanguageChoice } from "./i18n";
import type { UpdateInfo } from "./update";

// What the preload script gives the page (window.finx). Everything about
// sessions comes from finx itself, over the port connectKernel hands out.

export type PlatformId = "mac" | "win" | "linux";

export type MenuItem = { id: string; label: string; enabled?: boolean; checked?: boolean } | { separator: true };

/** Commands from the app menu, handled by the main window's page. */
export type Command =
  | "newSession" | "openProject" | "attachFiles" | "attachFolder" | "search" | "nextAttention" | "nextActive"
  | "toggleInspector" | "toggleSidebar"
  | "approve" | "interrupt" | "rename" | "archive" | "unarchive" | "copySessionId" | "revealSessionFile"
  | "undo";

/** What the page shows, so the app menu's items enable and check right. */
export type MenuState = {
  main: boolean;
  session: null | {
    interruptible: boolean;
    approvable: boolean;
    archivable: boolean;
    archived: boolean;
    inspector: boolean;
  };
  sidebar: boolean;
  /** The toast offers Undo (⌘Z undoes it rather than typing). */
  undo: boolean;
};

/**
 * A file the person picked to attach: an image comes with its bytes (base64,
 * as the protocol's image content takes them); any other file by its path.
 */
export type PickedFile = { path: string; name: string } & ({ kind: "file" } | { kind: "image"; mime_type: string; data: string });

/** Light or dark: the system's, or one chosen for the app. */
export type Appearance = "system" | "light" | "dark";

export type Preferences = {
  appearance: Appearance;
  /** A change takes effect when the app next starts. */
  language: LanguageChoice;
  /** "Don't ask again" when the app offered to move to the Applications folder. */
  moveDeclined?: boolean;
};

/** A window's browser panel (browser-design §8.3.4): the session it shows, and where, in window coordinates; none while hidden. */
export type BrowserPanel = { session: string | null; rect: { x: number; y: number; width: number; height: number } | null };

/** A tab of the embedded browser. */
export type BrowserTab = {
  targetId: string;
  session: string | null;
  url: string;
  title: string;
  shown: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

/** What the person does to a tab in the panel. "new" opens a tab beside it, for its session. */
export type BrowserTabCommand = { command: "back" | "forward" | "reload" | "stop" | "close" | "new" } | { command: "go"; url: string };

/** Where the window's sessions come from: finx, or the demo's mock server (FINXWORK_KERNEL=mock). */
export type KernelKind = "mock" | "finx";

/** How finx's service is, as the main process's supervisor sees it (desktop-kernel-integration §6.1). */
export type KernelStatusView = {
  state: "starting" | "ready" | "reconnecting" | "failed";
  /** The running service's version. */
  version?: string;
  /** An older or different build, replaced once no task runs. */
  replacing?: boolean;
  /** Started from the app's own finx. */
  ours?: boolean;
  attempt?: number;
  /** Failed: why, and what finx printed. */
  reason?: string;
  output?: string;
  endpoint: string;
  binary: string | null;
  env?: "login" | "fallback";
  /** finx's output when the app starts it. */
  log: string;
  home: string;
};

export type Bridge = {
  /** The embedded browser: where this window's panel is, the tabs there are, and picking one. */
  setBrowserPanel(panel: BrowserPanel): void;
  browserTabs(): Promise<BrowserTab[]>;
  onBrowserTabs(cb: (tabs: BrowserTab[]) => void): () => void;
  showBrowserTab(targetId: string): void;
  browserTabCommand(targetId: string, command: BrowserTabCommand): void;
  openSourceApp(adapter?: "qwenwork" | "qoder"): Promise<void>;
  /** The local application's own icon, as the system draws it (a data URL), or null when it isn't installed. */
  sourceAppIcon(adapter?: "qwenwork" | "qoder"): Promise<string | null>;
  platform: PlatformId;
  userName: string;
  home: string;
  version: string;
  /** The app's language for this run, chosen by the main process. */
  language: Language;
  kernel: KernelKind;
  /**
   * Asks for a connection to finx: a MessagePort, posted to the window as a
   * "finx-kernel" message. Its messages are NDJSON text both ways.
   */
  connectKernel(): void;
  /** The kernel's state now, and as it changes. */
  kernelStatus(): Promise<KernelStatusView>;
  onKernelState(cb: (s: KernelStatusView) => void): () => void;
  /** After a failure: start over. */
  retryKernel(): void;
  /** Starts finx again with a fresh login environment: now (running tasks are interrupted), or once no task runs. */
  restartKernel(now: boolean): void;
  /** The settings window, on a page ("general", "models"). */
  openSettings(page?: string): void;
  /** In the settings window: another page was asked for while it is open. */
  onSettingsPage(cb: (page: string) => void): () => void;
  /** In the main window: whether the settings window is open now, and as that changes (the window dims behind it). */
  settingsOpen(): Promise<boolean>;
  onSettingsOpen(cb: (open: boolean) => void): () => void;
  /** A native menu at the pointer; resolves to the chosen item's id. */
  popupMenu(items: MenuItem[]): Promise<string | null>;
  onCommand(cb: (c: Command) => void): () => void;
  setMenuState(state: MenuState): void;
  pickDirectory(): Promise<string | null>;
  /** A skill to upload, from the system's dialog: a folder, or a .zip, .skill or .md file. */
  pickSkillSource(): Promise<string | null>;
  /** The path of a file or folder dropped on the page. */
  pathForFile(file: File): string;
  /** The 自定义 page's catalog skills: in the app's resources, or the repository's in development. */
  catalogDir: string;
  /** Files to attach, from the system's dialog; images read (up to 10 MB each), others by path. */
  pickFiles(): Promise<PickedFile[]>;
  /** Shows a file or folder in Finder (Explorer, the file manager). */
  revealPath(path: string): void;
  /** Opens a folder itself in Finder (Explorer, the file manager). */
  openFolder(path: string): void;
  /** A new terminal window, its shell in this folder. */
  openTerminal(path: string): void;
  /** The git branch checked out where this folder lies (a detached HEAD's short id), or null outside a repository. */
  gitBranch(path: string): Promise<string | null>;
  openExternal(url: string): void;
  showAbout(): void;
  getPreferences(): Promise<Preferences>;
  setPreferences(p: Partial<Preferences>): Promise<Preferences>;
  /** Quits and opens the app again (a new language takes effect). */
  relaunch(): void;
  /** Where the app is with its next version, and as that changes. */
  updates(): Promise<UpdateInfo>;
  onUpdate(cb: (u: UpdateInfo) => void): () => void;
  checkForUpdates(): void;
  downloadUpdate(): void;
  /** Quits, installs the downloaded version and opens it; tasks go on in finx. */
  installUpdate(): void;
  /** "Later": no reminder of this version in the sidebar for a day. */
  snoozeUpdate(): void;
  setAutoDownload(on: boolean): Promise<UpdateInfo>;
};

declare global {
  interface Window {
    finx?: Bridge;
  }
}
