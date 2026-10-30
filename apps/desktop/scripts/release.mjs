#!/usr/bin/env node
// Publishes this version of finxwork as a GitHub release of the public
// releases repository (docs/desktop/desktop-release.md §6). Each architecture is
// built, signed and notarized (build-app.mjs); the disk images, zips and
// feeds go to a draft release, which is published once all are there: until
// then the newest release, and so what installed apps find, stays the
// previous one.
//
//   pnpm release                 arm64 and x64
//   pnpm release --arch arm64    one architecture
//   pnpm release --dry-run       build and check everything, publish nothing
//
// Needs gh signed in with write access to the releases repository, notary
// credentials (FINXWORK_NOTARY_*, as build-app.mjs reads them), a clean
// working tree, and what changed in apps/desktop/releases/<version>.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { dmgName, feedName, feedVersion, githubReleases, newer, releaseRepo, releaseURLs, validVersion, zipName } from "../src/shared/update.ts";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const { values: opts } = parseArgs({ options: { arch: { type: "string", default: "arm64,x64" }, "dry-run": { type: "boolean", default: false } } });
const archs = opts.arch.split(",").map((a) => a.trim()).filter(Boolean);
const dry = opts["dry-run"];
const version = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8")).version;
const tag = `v${version}`;
const prerelease = version.includes("-");

const out = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const fail = (message) => {
  console.error(`release ${tag}: ${message}`);
  process.exit(1);
};
// What only publishing needs; a dry run says what is missing and goes on.
const ready = (ok, message) => ok || (dry ? console.warn(`release ${tag}: ${message} (ignored in a dry run)`) : fail(message));

// Everything that can stop a release, before the long builds.
if (!validVersion(version)) fail(`package.json's version "${version}" is not x.y.z or x.y.z-pre`);
for (const a of archs) if (!["arm64", "x64"].includes(a)) fail(`unknown architecture ${a}`);
const notes = path.join(desktop, "releases", `${version}.md`);
ready(fs.existsSync(notes) && fs.readFileSync(notes, "utf8").trim() !== "", `write what changed for people in ${path.relative(root, notes)}`);
ready(!out("git", ["status", "--porcelain"], { cwd: root }), "the working tree has changes: a release is built from a commit");
if (!process.env.FINXWORK_NOTARY_PROFILE && !process.env.FINXWORK_NOTARY_KEY_PATH) fail("no notary credentials: set FINXWORK_NOTARY_PROFILE, or FINXWORK_NOTARY_KEY_PATH, _KEY_ID and _ISSUER");
// Another architecture's kernel needs its Rust target, for the toolchain rust-toolchain.toml pins (so asked from the repository).
const rustup = process.env.RUSTUP || [path.join(os.homedir(), ".cargo/bin/rustup")].find((p) => fs.existsSync(p)) || "rustup";
for (const [a, triple] of [["x64", "x86_64-apple-darwin"], ["arm64", "aarch64-apple-darwin"]]) {
  if (!archs.includes(a) || process.arch === (a === "x64" ? "x64" : "arm64")) continue;
  let targets = [];
  try {
    targets = out(rustup, ["target", "list", "--installed"], { cwd: root }).split("\n");
  } catch {
    fail(`cannot run rustup to check the ${a} target; set RUSTUP`);
  }
  if (!targets.includes(triple)) fail(`the ${a} kernel needs Rust's ${triple} target: cd ${root} && ${rustup} target add ${triple} (or --arch ${process.arch})`);
}
const quiet = { stdio: ["ignore", "pipe", "ignore"] };
const visibility = (() => {
  try {
    return out("gh", ["repo", "view", releaseRepo, "--json", "visibility", "-q", ".visibility"], quiet);
  } catch {
    return "";
  }
})();
const reachable = visibility !== "";
ready(reachable, `cannot reach github.com/${releaseRepo}: create it (public, releases only) and sign gh in`);
// Installed apps download without signing in: a private repository answers them 404, which reads as "up to date".
if (reachable && visibility !== "PUBLIC") fail(`github.com/${releaseRepo} is ${visibility.toLowerCase()}: installed apps can only read a public one`);
let latest = "";
if (reachable) {
  // Drafts too: one left by a stopped release holds the tag.
  const tags = out("gh", ["release", "list", "--repo", releaseRepo, "--limit", "1000", "--json", "tagName", "-q", ".[].tagName"], quiet).split("\n");
  if (tags.includes(tag)) fail(`${releaseRepo} already has ${tag} (perhaps as a draft)`);
  try {
    latest = out("gh", ["release", "view", "--repo", releaseRepo, "--json", "tagName", "-q", ".tagName"], quiet).replace(/^v/, "");
  } catch {
    // The first release.
  }
}
if (latest && !prerelease && !newer(version, latest)) fail(`${version} is not newer than the latest release, ${latest}: installed apps would not take it`);

const commit = out("git", ["rev-parse", "--short", "HEAD"], { cwd: root });
console.log(`› finxwork ${version} (${commit}) for ${archs.join(", ")} → ${releaseRepo}${latest ? `, after ${latest}` : ""}${dry ? ", dry run" : ""}`);

const files = [];
for (const arch of archs) {
  const dist = path.join(root, "dist", "release", arch);
  fs.rmSync(dist, { recursive: true, force: true });
  sh(process.execPath, [path.join(desktop, "scripts/build-app.mjs")], {
    env: { ...process.env, FINXWORK_ARCH: arch, FINXWORK_DIST: dist, VERSION: version, FINXWORK_RELEASES: githubReleases(releaseRepo), FINXWORK_NO_DMG: "", FINXWORK_TEST_HOME: "" },
  });
  // What installed apps will read: the feed of this version, naming its own zip on GitHub.
  const feed = JSON.parse(fs.readFileSync(path.join(dist, feedName(arch)), "utf8"));
  if (feedVersion(feed) !== version || feed.releases[0].updateTo.url !== releaseURLs(githubReleases(releaseRepo), arch).zip(version)) fail(`${feedName(arch)} does not name ${zipName(arch)} of ${tag}`);
  files.push(...[dmgName(arch), zipName(arch), feedName(arch)].map((f) => path.join(dist, f)));
}
for (const f of files) if (!fs.existsSync(f)) fail(`${f} is missing`);

if (dry) {
  console.log(`dry run: would publish\n${files.map((f) => `  ${path.relative(root, f)}`).join("\n")}`);
  process.exit(0);
}

const title = `FinxWork ${version}`;
sh("gh", ["release", "create", tag, "--repo", releaseRepo, "--draft", "--title", title, "--notes-file", notes, ...(prerelease ? ["--prerelease"] : [])]);
try {
  sh("gh", ["release", "upload", tag, "--repo", releaseRepo, ...files]);
  // One step: the release, and with it the newest feed, appears with all its files.
  sh("gh", ["release", "edit", tag, "--repo", releaseRepo, "--draft=false", ...(prerelease ? [] : ["--latest"])]);
} catch {
  // Nobody sees a draft: installed apps still read the previous release.
  fail(`publishing stopped; the draft ${tag} is left on https://github.com/${releaseRepo}/releases: finish it there, or delete it (gh release delete ${tag} --repo ${releaseRepo}) and run again`);
}
console.log(`✓ https://github.com/${releaseRepo}/releases/tag/${tag}`);
