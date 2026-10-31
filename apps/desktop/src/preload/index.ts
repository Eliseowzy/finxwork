import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Bridge, Command, KernelKind, KernelStatusView, MenuItem, MenuState, PlatformId, Preferences } from "../shared/bridge";
import type { Language } from "../shared/i18n";
import type { UpdateInfo } from "../shared/update";

// The only things the page gets from outside its sandbox (window.finx).
// Sessions come from finx over the port connectKernel hands out.
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--finx-${name}=`))?.split("=").slice(1).join("=") ?? "";

const listen = <T>(channel: string, cb: (v: T) => void) => {
  const h = (_: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => {
    ipcRenderer.removeListener(channel, h);
  };
};

// The kernel's port arrives here (ports can't cross the bridge's proxy);
// it goes on to the page's own world as a window message, where the page
// holds it directly.
ipcRenderer.on("finx-kernel", (e) => window.postMessage("finx-kernel", "*", e.ports));

const bridge: Bridge = {
  openSourceApp: (adapter?: "qwenwork" | "qoder") => ipcRenderer.invoke("open-source-app", adapter),
  sourceAppIcon: (adapter?: "qwenwork" | "qoder") => ipcRenderer.invoke("source-app-icon", adapter),
  platform: arg("platform") as PlatformId,
  userName: arg("user"),
  home: arg("home"),
  version: arg("version"),
  language: arg("lang") as Language,
  kernel: arg("kernel") as KernelKind,
  connectKernel: () => ipcRenderer.send("connect-kernel"),
  kernelStatus: () => ipcRenderer.invoke("kernel-status"),
  onKernelState: (cb: (s: KernelStatusView) => void) => listen("kernel-state", cb),
  retryKernel: () => ipcRenderer.send("retry-kernel"),
  restartKernel: (now: boolean) => ipcRenderer.send("restart-kernel", now),
  openSettings: (page?: string) => ipcRenderer.send("open-settings", page),
  onSettingsPage: (cb: (page: string) => void) => listen("settings-page", cb),
  settingsOpen: () => ipcRenderer.invoke("settings-open"),
  onSettingsOpen: (cb: (open: boolean) => void) => listen("settings-open", cb),
  popupMenu: (items: MenuItem[]) => ipcRenderer.invoke("popup-menu", items),
  onCommand: (cb: (c: Command) => void) => listen("command", cb),
  setMenuState: (s: MenuState) => ipcRenderer.send("menu-state", s),
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  pickSkillSource: () => ipcRenderer.invoke("pick-skill-source"),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  catalogDir: arg("catalog"),
  pickFiles: () => ipcRenderer.invoke("pick-files"),
  revealPath: (path: string) => ipcRenderer.send("reveal-path", path),
  openFolder: (path: string) => ipcRenderer.send("open-folder", path),
  openTerminal: (path: string) => ipcRenderer.send("open-terminal", path),
  gitBranch: (path: string) => ipcRenderer.invoke("git-branch", path),
  openExternal: (url: string) => ipcRenderer.send("open-external", url),
  showAbout: () => ipcRenderer.send("show-about"),
  getPreferences: () => ipcRenderer.invoke("preferences"),
  setPreferences: (p: Partial<Preferences>) => ipcRenderer.invoke("set-preferences", p),
  relaunch: () => ipcRenderer.send("relaunch"),
  updates: () => ipcRenderer.invoke("update-info"),
  onUpdate: (cb: (u: UpdateInfo) => void) => listen("update", cb),
  checkForUpdates: () => ipcRenderer.send("check-updates"),
  downloadUpdate: () => ipcRenderer.send("download-update"),
  installUpdate: () => ipcRenderer.send("install-update"),
  snoozeUpdate: () => ipcRenderer.send("snooze-update"),
  setAutoDownload: (on: boolean) => ipcRenderer.invoke("set-auto-download", on),
};

contextBridge.exposeInMainWorld("finx", bridge);
