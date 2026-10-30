import path from "node:path";
import { loginEnvironment } from "../kernel/env";
import type { Platform } from "./types";

// macOS: a hidden-inset title bar with the traffic lights on the middle of
// the 52 px top band, and the sidebar material showing through the sidebar
// (the page leaves it see-through; the content is opaque).

export const darwin: Platform = {
  id: "mac",
  chrome: () => ({
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 20 },
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
  }),
  appMenu: true,
  quitWithLastWindow: false,
  kernelEndpoint: (home) => path.join(home, "run", "finx.sock"),
  // Helper tools belong in Contents/MacOS, next to the app's own executable (desktop-kernel-integration §4.1).
  kernelBinary: () => path.join(path.dirname(process.execPath), "finx"),
  loginEnvironment,
};
