#!/usr/bin/env node
// Development runs use the agent-desktop FinxWork ships (docs/desktop/computer-use-design.md §4):
// the pinned release (scripts/agent-desktop.mjs), checked, put beside the repository's debug
// finx, where finx and the app look first, as they find it beside finx in Contents/MacOS. macOS
// only. Without the network the first time, it says why and lets the build go on.
import fs from "node:fs";
import path from "node:path";
import { agentDesktopBinaries, agentDesktopFiles } from "./agent-desktop.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const target = path.resolve(desktop, "../../target/debug");

if (process.platform === "darwin") {
  try {
    const files = agentDesktopBinaries(process.arch === "arm64" ? "arm64" : "x64", path.join(desktop, "node_modules/.cache/agent-desktop"));
    fs.mkdirSync(target, { recursive: true });
    for (const name of agentDesktopFiles) {
      const to = path.join(target, name);
      if (fs.existsSync(to) && fs.readFileSync(to).equals(fs.readFileSync(files[name]))) continue;
      fs.copyFileSync(files[name], to);
      fs.chmodSync(to, 0o755);
    }
  } catch (e) {
    console.warn(`agent-desktop for development: ${e instanceof Error ? e.message : e}`);
  }
}
