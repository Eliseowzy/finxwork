import path from "node:path";
import { loginEnvironment } from "../kernel/env";
import type { Platform } from "./types";

// Linux (phase 4, not yet tried on Linux): the system's own title bar for
// now, which every desktop environment draws its own way.

export const linux: Platform = {
  id: "linux",
  chrome: () => ({}),
  appMenu: false,
  quitWithLastWindow: true,
  kernelEndpoint: (home) => path.join(home, "run", "finx.sock"),
  kernelBinary: () => path.join(process.resourcesPath, "bin", "finx"),
  loginEnvironment,
};
