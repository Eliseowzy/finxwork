import assert from "node:assert/strict";
import { test } from "node:test";
import { feedVersion, githubReleases, newer, nextCheckDelay, nextUpdate, releaseFeed, releaseURLs, remind, squirrelFailure, type Update, type UpdateInfo } from "./update.ts";

test("versions compare part by part, as numbers, and a release is newer than its pre-releases", () => {
  assert.ok(newer("0.10.0", "0.9.1"));
  assert.ok(newer("1.0.0", "0.99.99"));
  assert.ok(!newer("0.1.0", "0.1.0"));
  assert.ok(!newer("0.1.0", "0.1.1"));
  assert.ok(newer("1.0.0", "1.0.0-beta.2"));
  assert.ok(!newer("1.0.0-beta.2", "1.0.0"));
  assert.ok(newer("1.0.0-beta.10", "1.0.0-beta.9"));
});

test("a feed offers a newer version for download, and nothing else", () => {
  const idle: Update = { state: "idle" };
  const feed = (latest: string, autoDownload = true) => nextUpdate({ state: "checking" }, { type: "feed", latest, current: "0.2.0", autoDownload });
  assert.deepEqual(nextUpdate(idle, { type: "check" }), { state: "checking" });
  assert.deepEqual(feed("0.3.0"), { state: "downloading", version: "0.3.0" });
  assert.deepEqual(feed("0.3.0", false), { state: "available", version: "0.3.0" });
  // An older release (one pulled back as the latest) is never installed.
  assert.deepEqual(feed("0.1.9"), { state: "current" });
  assert.deepEqual(feed("0.2.0"), { state: "current" });
  // No release for this architecture.
  assert.deepEqual(feed(""), { state: "current" });
});

test("a downloaded update stays ready, and checking again leaves a download running", () => {
  const ready: Update = { state: "ready", version: "0.3.0" };
  assert.deepEqual(nextUpdate(ready, { type: "check" }), ready);
  assert.deepEqual(nextUpdate(ready, { type: "error", reason: "network", message: "offline" }), ready);
  const downloading: Update = { state: "downloading", version: "0.3.0" };
  assert.deepEqual(nextUpdate(downloading, { type: "check" }), downloading);
  assert.deepEqual(nextUpdate(downloading, { type: "downloaded", version: "" }), ready);
  assert.deepEqual(nextUpdate({ state: "unsupported" }, { type: "check" }), { state: "unsupported" });
});

test("Squirrel's refusal of a read-only place is told apart from a failed download", () => {
  assert.equal(squirrelFailure("Cannot update while running on a read-only volume. The application is on a disk image or in a translocated location."), "location");
  assert.equal(squirrelFailure("The network connection was lost."), "download");
});

test("checks are four hours apart, and back off after failures", () => {
  const now = 10 * 60 * 60_000;
  assert.equal(nextCheckDelay(null, null, 0, now), 0);
  assert.equal(nextCheckDelay(now - 60 * 60_000, null, 0, now), 3 * 60 * 60_000);
  assert.equal(nextCheckDelay(now - 5 * 60 * 60_000, null, 0, now), 0);
  assert.equal(nextCheckDelay(now, now, 1, now), 5 * 60_000);
  assert.equal(nextCheckDelay(now, now, 2, now), 30 * 60_000);
  assert.equal(nextCheckDelay(now, now, 9, now), 120 * 60_000);
});

test("a release's feed names that version's own zip, and the app finds the newest feed by a fixed address", () => {
  const urls = releaseURLs(githubReleases("finxwork/finxwork-releases"), "arm64");
  assert.equal(urls.latestFeed, "https://github.com/finxwork/finxwork-releases/releases/latest/download/RELEASES-darwin-arm64.json");
  assert.equal(urls.feed("0.3.0"), "https://github.com/finxwork/finxwork-releases/releases/download/v0.3.0/RELEASES-darwin-arm64.json");
  const feed = releaseFeed({ version: "0.3.0", zip: urls.zip("0.3.0"), page: urls.page("0.3.0"), date: new Date("2026-10-29T08:00:00.123Z") });
  assert.equal(feedVersion(feed), "0.3.0");
  assert.equal(feed.releases[0].updateTo.url, "https://github.com/finxwork/finxwork-releases/releases/download/v0.3.0/FinxWork-macos-arm64.zip");
  assert.equal(feed.releases[0].updateTo.pub_date, "2026-10-29T08:00:00Z");
  assert.throws(() => feedVersion({ releases: [] }));
  assert.throws(() => feedVersion({ currentRelease: "latest" }));
});

test("Later hides the reminder of that version for a while, not of the next one", () => {
  const info = (u: Update, snoozedVersion = "", snoozedUntil = 0): UpdateInfo => ({ version: "0.2.0", update: u, autoDownload: true, checkedAt: null, snoozedVersion, snoozedUntil, notesURL: null });
  const ready: Update = { state: "ready", version: "0.3.0" };
  assert.ok(remind(info(ready), 1000));
  assert.ok(!remind(info(ready, "0.3.0", 2000), 1000));
  assert.ok(remind(info(ready, "0.3.0", 2000), 3000));
  assert.ok(remind(info({ state: "available", version: "0.4.0" }, "0.3.0", 2000), 1000));
  assert.ok(!remind(info({ state: "downloading", version: "0.3.0" }), 1000));
});
