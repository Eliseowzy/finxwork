import { nativeTheme } from "electron";
import os from "node:os";
import path from "node:path";
import type { Platform } from "./types";

// Windows (phase 4, not yet tried on Windows): the system's caption buttons
// over the page's 52 px top band, on the right, and the Mica material.

export const win32: Platform = {
  id: "win",
  chrome: () => ({
    titleBarStyle: "hidden",
    titleBarOverlay: {
      height: 52,
      color: "#00000000",
      symbolColor: nativeTheme.shouldUseDarkColors ? "#ffffff" : "#000000",
    },
    backgroundMaterial: "mica",
  }),
  appMenu: false,
  quitWithLastWindow: true,
  // desktop-design DQ-05 and P7: a named pipe for the user only.
  kernelEndpoint: () => `\\\\.\\pipe\\finx-${os.userInfo().username}`,
  kernelBinary: () => path.join(process.resourcesPath, "bin", "finx.exe"),
  // Windows apps get the user's full environment; there is no login shell to ask.
  loginEnvironment: async () => ({ env: process.env, source: "login", ms: 0 }),
};
