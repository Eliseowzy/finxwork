// The app's updates (desktop-release.md §4): the state the main process keeps
// (main/updater.ts) and the windows show, and what a release publishes
// (scripts/build-app.mjs, scripts/release.mjs). No imports, so the scripts
// and `node --test` load this file as it is.

/**
 * The public repository whose GitHub releases carry the app: its disk images,
 * the zips installed apps update from, and their feeds (desktop-release DD-20).
 * The source repository is private, and an app cannot carry a token to read it.
 */
export const releaseRepo = "finxwork/finxwork-releases";

/** Where the app is with its next version. */
export type Update =
  /** Development and ad-hoc signed builds, and platforms without updates yet. */
  | { state: "unsupported" }
  | { state: "idle" }
  | { state: "checking" }
  /** Up to date. */
  | { state: "current" }
  /** A newer version, not downloaded: automatic download is off. */
  | { state: "available"; version: string }
  | { state: "downloading"; version: string }
  /** Downloaded and its signature verified: installed on quit, or now with Restart to Update. */
  | { state: "ready"; version: string }
  /** What went wrong, in words for the person, and the network's or Squirrel's own message under the details. */
  | { state: "error"; reason: UpdateFailure; message: string };

/**
 * Why an update failed: the feed could not be read (offline, or GitHub
 * failed); the app runs from a read-only place (a disk image, or App
 * Translocation), where Squirrel cannot replace it; or Squirrel failed to
 * download or verify the release.
 */
export type UpdateFailure = "network" | "location" | "download";

export type UpdateInfo = {
  /** The running app's version. */
  version: string;
  update: Update;
  /** Download updates as soon as they are found. */
  autoDownload: boolean;
  /** Last successful check (ms since the epoch), or null. */
  checkedAt: number | null;
  /** "Later" hides the sidebar's reminder of this version until snoozedUntil. */
  snoozedVersion: string;
  snoozedUntil: number;
  /** The release page of the version found, with its notes. */
  notesURL: string | null;
};

export type UpdateEvent =
  | { type: "check" }
  /** The feed was read: its version ("" when there is none for this architecture). */
  | { type: "feed"; latest: string; current: string; autoDownload: boolean }
  /** A download started (asked for, or by Squirrel after its own look at the feed). */
  | { type: "download" }
  | { type: "downloaded"; version: string }
  | { type: "not-available" }
  | { type: "error"; reason: UpdateFailure; message: string };

/** The next state. A downloaded update stays ready whatever happens next. */
export function nextUpdate(u: Update, e: UpdateEvent): Update {
  if (u.state === "ready" || u.state === "unsupported") return u;
  switch (e.type) {
    case "check":
      return u.state === "downloading" ? u : { state: "checking" };
    case "feed":
      if (!e.latest || !newer(e.latest, e.current)) return { state: "current" };
      return { state: e.autoDownload ? "downloading" : "available", version: e.latest };
    case "download":
      return { state: "downloading", version: "version" in u ? u.version : "" };
    case "downloaded":
      return { state: "ready", version: e.version || ("version" in u ? u.version : "") };
    case "not-available":
      return { state: "current" };
    case "error":
      return { state: "error", reason: e.reason, message: e.message };
  }
}

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** "1.2.3" or "1.2.3-beta.1": the versions a release may have. */
export function validVersion(v: unknown): v is string {
  return typeof v === "string" && versionPattern.test(v);
}

/**
 * Is version a newer than b? Dot-separated parts compare as numbers
 * ("0.10.0" > "0.9.1"); a pre-release part ("1.0.0-beta.2") as text, and
 * a release is newer than its pre-releases.
 */
export function newer(a: string, b: string): boolean {
  const [coreA, ...preA] = a.split("-");
  const [coreB, ...preB] = b.split("-");
  const c = compareParts(coreA.split("."), coreB.split("."), "0");
  if (c !== 0) return c > 0;
  if (!preA.length || !preB.length) return !preA.length && preB.length > 0;
  return compareParts(preA.join("-").split("."), preB.join("-").split("."), "") > 0;
}

function compareParts(a: string[], b: string[], missing: string): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? missing;
    const y = b[i] ?? missing;
    if (x === y) continue;
    const nx = Number(x);
    const ny = Number(y);
    if (x !== "" && y !== "" && Number.isInteger(nx) && Number.isInteger(ny)) return nx - ny;
    return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Why Squirrel.Mac failed, from its error. It refuses to update an app on a
 * read-only volume with this message (always English: the framework has no
 * translations); anything else happened while downloading or verifying.
 */
export function squirrelFailure(message: string): UpdateFailure {
  return /read-only volume/i.test(message) ? "location" : "download";
}

// --- What a release publishes ---

export const feedName = (arch: string) => `RELEASES-darwin-${arch}.json`;
export const zipName = (arch: string) => `FinxWork-macos-${arch}.zip`;
export const dmgName = (arch: string) => `FinxWork-macos-${arch}.dmg`;

/**
 * A release's files, under the releases' address (`https://github.com/<repo>/releases`,
 * or a test server laid out the same way). The newest release's feed has an
 * address of its own; GitHub redirects it to that release's, which is what
 * the app hands Squirrel, so it downloads exactly the version the app checked.
 */
export function releaseURLs(base: string, arch: string) {
  return {
    latestFeed: `${base}/latest/download/${feedName(arch)}`,
    feed: (version: string) => `${base}/download/v${version}/${feedName(arch)}`,
    zip: (version: string) => `${base}/download/v${version}/${zipName(arch)}`,
    page: (version: string) => `${base}/tag/v${version}`,
  };
}

/** The GitHub releases of a repository, as releaseURLs takes them. */
export const githubReleases = (repo: string) => `https://github.com/${repo}/releases`;

/**
 * Squirrel.Mac's JSON feed (serverType "json") for one release of one
 * architecture: currentRelease is its version, and the release it names
 * points at that version's zip.
 */
export function releaseFeed(r: { version: string; zip: string; page: string; date: Date }) {
  return {
    currentRelease: r.version,
    releases: [{ version: r.version, updateTo: { version: r.version, name: r.version, notes: r.page, pub_date: rfc3339(r.date), url: r.zip } }],
  };
}

/** The version a feed offers; throws when it is not a feed. */
export function feedVersion(feed: unknown): string {
  const v = (feed as { currentRelease?: unknown } | null)?.currentRelease;
  if (!validVersion(v)) throw new Error("not an update feed: currentRelease is missing or not a version");
  return v;
}

/** "2026-10-19T08:00:00Z": Squirrel.Mac parses dates without fractions of a second. */
function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

// --- When to look ---

export const checkEvery = 4 * 60 * 60 * 1000;

/** Success sets freshness; failed attempts set the retry backoff (5 min, 30 min, then 2 h), across launches too. */
export function nextCheckDelay(checkedAt: number | null, attemptedAt: number | null, failures: number, now: number): number {
  if (failures && attemptedAt !== null) {
    const delay = [5, 30, 120][Math.min(failures - 1, 2)] * 60_000;
    return Math.max(0, attemptedAt + delay - now);
  }
  return checkedAt === null ? 0 : Math.max(0, checkedAt + checkEvery - now);
}

/** The sidebar reminds of a found version unless "Later" hid it for now. */
export function remind(info: UpdateInfo, now: number): boolean {
  const u = info.update;
  if (u.state !== "ready" && u.state !== "available") return false;
  return !(info.snoozedVersion === u.version && now < info.snoozedUntil);
}
