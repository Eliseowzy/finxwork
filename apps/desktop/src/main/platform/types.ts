import type { BrowserWindowConstructorOptions } from "electron";
import type { PlatformId } from "../../shared/bridge";
import type { LoginEnvironment } from "../kernel/env";

// What differs between operating systems, in one place (desktop-design
// §4.2). The page only ever sees `data-platform`; everything else that
// depends on the OS is decided here.

export type WindowKind = "main" | "settings";

export interface Platform {
  id: PlatformId;
  /** The window's title bar, system buttons and material. */
  chrome(kind: WindowKind): BrowserWindowConstructorOptions;
  /** Whether the app has an application menu (macOS), or a menu bar that stays hidden until Alt. */
  appMenu: boolean;
  /** Quit when the last window closes (tasks go on in finx's own service either way). */
  quitWithLastWindow: boolean;
  /** Where finx's service listens: a Unix socket, or a named pipe on Windows (phase 4). */
  kernelEndpoint(finxHome: string): string;
  /** The finx binary inside the installed app. */
  kernelBinary(): string;
  /** The environment a service the app starts gets: the login shell's on macOS and Linux (desktop-kernel-integration §7). */
  loginEnvironment(): Promise<LoginEnvironment>;
  /** A new window of the system's terminal, its shell in this folder. */
  openTerminal(dir: string): void;
}
