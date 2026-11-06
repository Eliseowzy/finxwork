import { execFile } from "node:child_process";
import path from "node:path";
import { loginEnvironment } from "../kernel/env";
import type { Platform } from "./types";

// macOS: a hidden-inset title bar with the traffic lights on the middle of
// the 44 px top band. Opaque page surfaces provide the window's colours.

export const darwin: Platform = {
  id: "mac",
  chrome: () => ({
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 15 },
  }),
  appMenu: true,
  quitWithLastWindow: false,
  kernelEndpoint: (home) => path.join(home, "run", "finx.sock"),
  // Helper tools belong in Contents/MacOS, next to the app's own executable (desktop-kernel-integration §4.1).
  kernelBinary: () => path.join(path.dirname(process.execPath), "finx"),
  loginEnvironment,
  openTerminal: (dir) => execFile("/usr/bin/open", ["-a", "Terminal", dir], () => {}),
};
