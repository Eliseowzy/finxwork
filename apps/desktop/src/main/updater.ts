import { app, autoUpdater, BrowserWindow, net, powerMonitor } from "electron";
import fs from "node:fs";
import path from "node:path";
import { feedVersion, nextCheckDelay, nextUpdate, releaseURLs, squirrelFailure, type Update, type UpdateEvent, type UpdateFailure, type UpdateInfo } from "../shared/update";
import { releasesURL } from "./build";
import { showSettings } from "./windows";
import { endBrowser } from "./browser/pages";

// Updates from GitHub Releases (desktop-release §4). The app reads the newest
// release's feed itself and decides; only a newer version goes to Squirrel.Mac,
// pinned to that version's own feed. Squirrel downloads its zip, checks that
// it carries the same Developer ID signature as the running app, and installs
// it when the app quits. Checks are quiet, and nothing restarts the app
// under the person: tasks run on in finx either way.

const urls = releaseURLs(releasesURL, process.arch);
const supported = app.isPackaged && process.platform === "darwin" && releasesURL !== "";
let update: Update = { state: supported ? "idle" : "unsupported" };
export const updateListeners = new Set<() => void>();

type Saved = {
  autoDownload: boolean;
  checkedAt: number | null;
  attemptedAt: number | null;
  failures: number;
  snoozedVersion: string;
  snoozedUntil: number;
};
const file = () => path.join(app.getPath("userData"), "updates.json");
let saved: Saved | undefined;

function prefs(): Saved {
  if (saved) return saved;
  let s: Partial<Saved> = {};
  try {
    const v = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (v && typeof v === "object") s = v;
  } catch {
    // The first launch.
  }
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  saved = {
    autoDownload: s.autoDownload !== false,
    checkedAt: num(s.checkedAt),
    attemptedAt: num(s.attemptedAt),
    failures: Math.max(0, num(s.failures) ?? 0),
    snoozedVersion: typeof s.snoozedVersion === "string" ? s.snoozedVersion : "",
    snoozedUntil: num(s.snoozedUntil) ?? 0,
  };
  return saved;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(prefs()));
  } catch (e) {
    console.warn("could not save the update preferences:", e);
  }
}

export function updateInfo(): UpdateInfo {
  const p = prefs();
  const version = "version" in update && update.version ? update.version : null;
  return {
    version: app.getVersion(),
    update,
    autoDownload: p.autoDownload,
    checkedAt: p.checkedAt,
    snoozedVersion: p.snoozedVersion,
    snoozedUntil: p.snoozedUntil,
    notesURL: version ? urls.page(version) : null,
  };
}

function apply(e: UpdateEvent): Update {
  update = nextUpdate(update, e);
  changed();
  return update;
}

function changed() {
  updateListeners.forEach((f) => f());
  const info = updateInfo();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("update", info);
}

let timer: NodeJS.Timeout | undefined;

function schedule(minimum = 0) {
  clearTimeout(timer);
  if (!["idle", "current", "available", "error"].includes(update.state)) return;
  const p = prefs();
  const wait = Math.max(minimum, nextCheckDelay(p.checkedAt, p.attemptedAt, p.failures, Date.now()));
  timer = setTimeout(() => (net.isOnline() ? void check() : schedule(5 * 60_000)), wait);
}

/** A wake or a network that came back looks again, if the last check is old enough. */
function catchUp() {
  if (update.state !== "checking") schedule(10_000);
}

function failed(reason: UpdateFailure, message: string) {
  const p = prefs();
  p.attemptedAt = Date.now();
  p.failures++;
  save();
  apply({ type: "error", reason, message });
  schedule();
}

export function startUpdater() {
  if (!supported) return;
  autoUpdater.on("update-available", () => apply({ type: "download" }));
  autoUpdater.on("update-downloaded", (_e, _notes, name) => {
    prefs().failures = 0;
    save();
    apply({ type: "downloaded", version: name || ("version" in update ? update.version : "") });
    clearTimeout(timer);
  });
  autoUpdater.on("update-not-available", () => {
    apply({ type: "not-available" });
    schedule();
  });
  autoUpdater.on("error", (e) => {
    console.warn("update:", e.message);
    if (update.state !== "ready") failed(squirrelFailure(e.message), e.message);
  });
  // The first look waits until the app has settled.
  schedule(30_000);
  powerMonitor.on("resume", catchUp);
  let online = net.isOnline();
  setInterval(() => {
    const now = net.isOnline();
    if (now && !online) catchUp();
    online = now;
  }, 60_000).unref();
}

/** Reads the newest release's feed. A manual check skips the schedule; one already under way is the same check. */
export async function check() {
  if (!["idle", "current", "available", "error"].includes(update.state)) return;
  clearTimeout(timer);
  const p = prefs();
  p.attemptedAt = Date.now();
  apply({ type: "check" });
  let latest: string;
  try {
    const res = await net.fetch(urls.latestFeed, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
    // No release yet, or none for this architecture.
    if (res.status === 404) latest = "";
    else if (!res.ok) throw new Error(`${urls.latestFeed}: HTTP ${res.status}`);
    else latest = feedVersion(await res.json());
  } catch (e) {
    console.warn("update check:", e);
    return failed("network", e instanceof Error ? e.message : String(e));
  }
  p.checkedAt = Date.now();
  const next = apply({ type: "feed", latest, current: app.getVersion(), autoDownload: p.autoDownload });
  if (next.state !== "downloading") p.failures = 0;
  save();
  if (next.state === "downloading") fetchRelease(next.version);
  else schedule();
}

/** Squirrel downloads exactly the version checked: the feed of that release, not "the newest". */
function fetchRelease(version: string) {
  try {
    autoUpdater.setFeedURL({ url: urls.feed(version), serverType: "json" });
    autoUpdater.checkForUpdates();
  } catch (e) {
    failed("download", e instanceof Error ? e.message : String(e));
  }
}

export function download() {
  if (update.state !== "available") return;
  const version = update.version;
  clearTimeout(timer);
  apply({ type: "download" });
  fetchRelease(version);
}

/** Quits, installs and opens the new version. finx and its tasks go on; the new app replaces the old finx once none runs. */
export function install() {
  if (update.state !== "ready") return;
  // It closes every window before the app hears it quit: the browser's hidden one must not come back.
  endBrowser();
  autoUpdater.quitAndInstall();
}

/** "Later": the sidebar stops reminding of this version for a day. Quitting still installs it. */
export function snooze() {
  if (update.state !== "ready" && update.state !== "available") return;
  const p = prefs();
  p.snoozedVersion = update.version;
  p.snoozedUntil = Date.now() + 24 * 60 * 60_000;
  save();
  changed();
}

export function setAutoDownload(on: boolean): UpdateInfo {
  prefs().autoDownload = on;
  save();
  if (on && update.state === "available") download();
  else changed();
  return updateInfo();
}

/** The app menu's Check for Updates…: the settings' About page, which shows how the check goes. */
export function openUpdates() {
  showSettings("about");
  void check();
}
