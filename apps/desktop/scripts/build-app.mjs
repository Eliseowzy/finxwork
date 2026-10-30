#!/usr/bin/env node
// Builds, signs and (with notary credentials) notarizes finxwork into dist/
// at the repository's root (docs/desktop/desktop-release.md §3):
//   dist/FinxWork.app                  the app (its name as people see it; the executable, bundle ID and profile folder stay finxwork)
//   dist/FinxWork-macos-<arch>.dmg     what people download: drag FinxWork to Applications
//   dist/FinxWork-macos-<arch>.zip     what installed apps update from (Squirrel.Mac takes zips only)
//   dist/RELEASES-darwin-<arch>.json   the update feed naming that zip, for builds that update
// scripts/release.mjs publishes them as a GitHub release.
//
// The bundle:
//   Contents/MacOS/FinxWork              Electron
//   Contents/MacOS/finx                  the kernel, started by the app as finx's service (desktop-kernel-integration §4)
//   Contents/Resources/app.asar          main, preload and the page
//   Contents/Resources/kernel.json       the kernel's version and protocol version
//   Contents/Resources/Assets.car        the icon (assets/brand/macos/AppIcon.icon, compiled by actool): light and dark, macOS 26 on
//   Contents/Resources/electron.icns     the icon before macOS 26 (assets/brand/macos/AppIcon-light.icns: the solid mark at 16 and 32 px)
//
// Needs Node, pnpm, Rust (cargo), Xcode (actool, codesign) and python3 (for dmgbuild, kept in node_modules/.cache).
//
// Environment:
//   FINXWORK_SIGNING_IDENTITY   a signing identity; default the keychain's first "Developer ID Application", else
//                               ad-hoc. "-" signs ad-hoc: the app runs on this Mac only, and does not update
//   FINXWORK_NOTARY_PROFILE     notarize with credentials saved by `xcrun notarytool store-credentials <name>`, or
//   FINXWORK_NOTARY_KEY_PATH    notarize with an App Store Connect API key: the .p8 file,
//   FINXWORK_NOTARY_KEY_ID        its key ID
//   FINXWORK_NOTARY_ISSUER        and its issuer ID; with neither, nothing is notarized
//   FINXWORK_ARCH               arm64 or x64 (default: this Mac's)
//   FINXWORK_DIST               where to put it all (default: dist/ at the repository's root)
//   FINXWORK_NO_DMG             1: no disk image (test builds)
//   VERSION                     version (default: package.json's)
//   CARGO                       cargo to build the kernel with (default: cargo on PATH, then ~/.cargo/bin/cargo)
// Test builds only (scripts/update-e2e.mjs):
//   FINXWORK_RELEASES           where the app looks for updates, laid out as GitHub releases
//                               (default for Developer ID builds: the GitHub releases of releaseRepo; none ad-hoc)
//   FINXWORK_TEST_HOME          the folder of the app's profile and FINX_HOME, built into the app
import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";
import { sign } from "@electron/osx-sign";
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureRustTarget, rustTriples } from "./rust-target.mjs";
import { dmgName, feedName, githubReleases, releaseFeed, releaseRepo, releaseURLs, zipName } from "../src/shared/update.ts";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const dist = path.resolve(process.env.FINXWORK_DIST || path.join(root, "dist"));
const tmp = path.join(dist, "tmp");
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const version = process.env.VERSION || pkg.version;
const electronVersion = JSON.parse(fs.readFileSync(path.join(desktop, "node_modules/electron/package.json"), "utf8")).version;
const build = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
const arch = process.env.FINXWORK_ARCH || process.arch;
if (arch === "universal") throw new Error("a universal kernel is not built yet (desktop-kernel-integration DQ-10); use arm64 or x64");
if (!["arm64", "x64"].includes(arch)) throw new Error(`FINXWORK_ARCH: ${arch}`);

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`› ${s}`);

let identity = process.env.FINXWORK_SIGNING_IDENTITY || "";
if (!identity) {
  const found = /"(Developer ID Application[^"]*)"/.exec(execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }));
  identity = found ? found[1] : "-";
}
const need = (name) => process.env[name] || (() => { throw new Error(`FINXWORK_NOTARY_KEY_PATH is set but ${name} is not`); })();
const notaryAuth = process.env.FINXWORK_NOTARY_PROFILE
  ? ["--keychain-profile", process.env.FINXWORK_NOTARY_PROFILE]
  : process.env.FINXWORK_NOTARY_KEY_PATH
    ? ["--key", process.env.FINXWORK_NOTARY_KEY_PATH, "--key-id", need("FINXWORK_NOTARY_KEY_ID"), "--issuer", need("FINXWORK_NOTARY_ISSUER")]
    : null;
// Apple notarizes Developer ID signatures only; fail before the build rather than ship an app thought notarized.
if (notaryAuth && identity === "-") throw new Error("notary credentials are set but the signature is ad-hoc; set FINXWORK_SIGNING_IDENTITY to a Developer ID Application identity");
// Squirrel installs only an update signed like the running app, which an ad-hoc signature cannot promise: such builds don't look.
if (identity === "-" && process.env.FINXWORK_RELEASES) console.warn("⚠️  FINXWORK_RELEASES ignored: an ad-hoc signed app cannot verify updates");
const releases = identity === "-" ? "" : (process.env.FINXWORK_RELEASES ?? githubReleases(releaseRepo));
const makeDmg = process.env.FINXWORK_NO_DMG !== "1";

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

// The kernel first: the app is only as good as the finx inside it.
const cargo = process.env.CARGO || [path.join(os.homedir(), ".cargo/bin/cargo")].find((c) => fs.existsSync(c)) || "cargo";
const nativeArch = process.arch === "arm64" ? "arm64" : "x64";
// The dist profile (Cargo.toml): fat LTO, a quarter smaller than release, the same start-up time.
step(`building the kernel (finx, dist profile, ${arch})`);
const cargoArgs = ["build", "--profile", "dist", "--locked", "-p", "finx-cli"];
if (arch !== nativeArch) {
  ensureRustTarget(arch, root);
  cargoArgs.push("--target", rustTriples[arch]);
}
sh(cargo, cargoArgs, { cwd: root });
const kernel = path.join(root, "target", ...(arch !== nativeArch ? [rustTriples[arch]] : []), "dist", "finx");
const machO = { arm64: "arm64", x64: "x86_64" }[arch];
// A kernel of this Mac's architecture is asked; another one may not run here (no Rosetta), so its version comes from Cargo.
const kernelVersion = arch === nativeArch
  ? execFileSync(kernel, ["--version"], { encoding: "utf8" }).trim().split(/\s+/).pop()
  : JSON.parse(execFileSync(cargo, ["metadata", "--no-deps", "--format-version", "1"], { cwd: root, encoding: "utf8" })).packages.find((p) => p.name === "finx-cli").version;
if (execFileSync("lipo", ["-archs", kernel], { encoding: "utf8" }).trim() !== machO) throw new Error(`${kernel} is not ${machO}`);
const protocolVersion = JSON.parse(fs.readFileSync(path.join(root, "crates/finx-protocol/schema.json"), "utf8"))["x-protocol-version"];

step(`building the page, the preload and the main process (updates: ${releases || "none"})`);
const staged = path.join(tmp, "app");
sh("pnpm", ["--dir", desktop, "build"], {
  env: { ...process.env, FINXWORK_DESKTOP_OUT: staged, FINXWORK_RELEASES: releases, FINXWORK_TEST_HOME: process.env.FINXWORK_TEST_HOME ?? "" },
});
fs.writeFileSync(
  path.join(staged, "package.json"),
  JSON.stringify({ name: "finxwork", productName: "FinxWork", version, main: "main/index.js", type: "module" }, null, 2),
);

step("compiling the app icon");
// The brand's icons (assets/brand, made by its export.sh).
const brand = path.join(root, "assets/brand/macos");
const icns = path.join(brand, "AppIcon-light.icns");
const icons = path.join(tmp, "icon");
fs.mkdirSync(icons);
sh("xcrun", ["actool", path.join(brand, "AppIcon.icon"), "--compile", icons, "--platform", "macosx", "--minimum-deployment-target", "14.0",
  "--app-icon", "AppIcon", "--output-partial-info-plist", path.join(tmp, "AppIcon.plist")], { stdio: "ignore" });

step(`packaging FinxWork.app (${arch})`);
const [built] = await packager({
  dir: staged,
  out: tmp,
  name: "FinxWork",
  executableName: "FinxWork",
  electronVersion,
  platform: "darwin",
  arch,
  appBundleId: "com.finxwork.app",
  helperBundleId: "com.finxwork.app.helper",
  appVersion: version,
  buildVersion: build,
  appCategoryType: "public.app-category.developer-tools",
  icon: icns,
  asar: true,
  prune: false,
  overwrite: true,
  // The packager names the bundle after the executable (CFBundleDisplayName, what Finder, the Dock and
  // Launchpad show, set after extendInfo); here, the app's languages (src/locales), which macOS offers
  // in System Settings' per-app language.
  extendInfo: { CFBundleIconName: "AppIcon", LSMinimumSystemVersion: "14.0", CFBundleDevelopmentRegion: "en", CFBundleLocalizations: ["en", "zh_CN"] },
});
const app = path.join(dist, "FinxWork.app");
fs.rmSync(app, { recursive: true, force: true });
fs.renameSync(path.join(built, "FinxWork.app"), app);

const contents = path.join(app, "Contents");
fs.cpSync(path.join(root, "crates/finx-connections/licenses"), path.join(contents, "Resources/model-connection-licenses"), { recursive: true });
// Electron brings a folder for each language Chromium speaks; macOS takes
// them for the app's languages, so only the app's own stay.
for (const f of fs.readdirSync(path.join(contents, "Resources"))) {
  if (f.endsWith(".lproj") && !["en.lproj", "zh_CN.lproj"].includes(f)) fs.rmSync(path.join(contents, "Resources", f), { recursive: true });
}
fs.copyFileSync(path.join(icons, "Assets.car"), path.join(contents, "Resources/Assets.car"));

step(`embedding the kernel: finx ${kernelVersion}, protocol ${protocolVersion}`);
// Helper tools go in Contents/MacOS, next to the app's executable, never in Resources,
// where signing and notarization treat Mach-O files as data.
const embedded = path.join(contents, "MacOS/finx");
fs.copyFileSync(kernel, embedded);
fs.chmodSync(embedded, 0o755);
fs.writeFileSync(path.join(contents, "Resources/kernel.json"), JSON.stringify({ version: kernelVersion, protocol_version: protocolVersion }) + "\n");

step("flipping Electron fuses");
await flipFuses(path.join(contents, "MacOS/FinxWork"), {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
});

step(`signing with: ${identity === "-" ? "ad-hoc" : identity}`);
await sign({
  app,
  identity,
  identityValidation: identity !== "-",
  platform: "darwin",
  // The hardened runtime's library validation needs one team ID across the
  // bundle, which an ad-hoc signature does not have.
  // The kernel needs no entitlement: it reads and writes the user's files, starts processes
  // and opens connections, all of which the hardened runtime allows. V8's JIT is Electron's.
  optionsForFile: (file) => ({
    hardenedRuntime: identity !== "-",
    entitlements: file.endsWith("/Contents/MacOS/finx") ? undefined : path.join(desktop, "build/darwin/entitlements.plist"),
  }),
});
sh("codesign", ["--verify", "--strict", "--deep", app]);
sh("codesign", ["--verify", "--strict", embedded]);
// The signed copy still runs and reports the version the app expects (where it can run).
if (arch === nativeArch) {
  const signedVersion = execFileSync(embedded, ["--version"], { encoding: "utf8" }).trim().split(/\s+/).pop();
  if (signedVersion !== kernelVersion) throw new Error(`the embedded finx reports ${signedVersion}, expected ${kernelVersion}`);
}

if (notaryAuth) {
  step("notarizing the app (usually a few minutes, at most an hour)");
  // The service takes a zip, not a bare .app; the ticket is stapled to the app, so the zip handed out is made after.
  const submission = path.join(tmp, "notarize.zip");
  sh("ditto", ["-c", "-k", "--keepParent", app, submission]);
  notarize(app, submission);
  // Gatekeeper's own check, as on a Mac the app is downloaded to.
  sh("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
}

const zip = path.join(dist, zipName(arch));
fs.rmSync(zip, { force: true });
sh("ditto", ["-c", "-k", "--keepParent", app, zip]);

// The disk image holds the notarized, stapled app and is itself signed,
// notarized and stapled: Apple notarizes the outermost container, and the
// tickets let Gatekeeper pass both offline.
const dmg = path.join(dist, dmgName(arch));
fs.rmSync(dmg, { force: true });
if (makeDmg) {
  step("making the disk image");
  sh(dmgbuild(), ["-s", path.join(desktop, "build/dmg/settings.py"), "-D", `app=${app}`, "-D", `icon=${icns}`,
    "-D", `background=${path.join(desktop, "build/dmg/background.png")}`, "FinxWork", dmg]);
  if (identity !== "-") sh("codesign", ["--sign", identity, "--timestamp", dmg]);
  if (notaryAuth) {
    step("notarizing the disk image");
    notarize(dmg);
    sh("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg]);
  }
}

// The feed: the zip of this very version, so a feed never names another version's zip.
const feed = path.join(dist, feedName(arch));
fs.rmSync(feed, { force: true });
if (releases) {
  const urls = releaseURLs(releases, arch);
  fs.writeFileSync(feed, JSON.stringify(releaseFeed({ version, zip: urls.zip(version), page: urls.page(version), date: new Date() }), null, 2) + "\n");
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log([app, makeDmg && dmg, zip, releases && feed].filter(Boolean).map((f) => `✓ ${f}`).join("\n"));
if (identity === "-") console.warn("⚠️  ad-hoc signature: it runs on this Mac and never updates; a copy downloaded elsewhere is blocked by Gatekeeper.");
else if (!notaryAuth) console.warn("⚠️  signed but not notarized: a copy downloaded elsewhere is blocked on first open. Set FINXWORK_NOTARY_PROFILE or FINXWORK_NOTARY_KEY_PATH, _KEY_ID and _ISSUER.");

/** Apple's notarization of `file`, sent as `submission` (an app goes as a zip); the ticket is stapled to `file`. */
function notarize(file, submission = file) {
  // An Invalid result does not always exit non-zero: the status in the JSON decides.
  let out = "";
  try {
    out = execFileSync("xcrun", ["notarytool", "submit", submission, ...notaryAuth, "--wait", "--timeout", "60m", "--output-format", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  } catch (e) {
    out = e.stdout || "";
  }
  let result = {};
  try { result = JSON.parse(out); } catch {}
  if (result.status !== "Accepted") {
    if (out) console.error(out);
    // The log lists each rejected file and why.
    if (result.id) try { sh("xcrun", ["notarytool", "log", result.id, ...notaryAuth]); } catch {}
    throw new Error(`notarization of ${path.basename(file)} did not pass: ${result.status || "the submission failed"}`);
  }
  sh("xcrun", ["stapler", "staple", file]);
  console.log(`notarized ${path.basename(file)} (submission ${result.id})`);
}

/** dmgbuild (build/dmg/requirements.txt, pinned with hashes) in a virtual environment of its own, kept between builds. */
function dmgbuild() {
  const venv = path.join(desktop, "node_modules/.cache/dmgbuild");
  const requirements = path.join(desktop, "build/dmg/requirements.txt");
  const installed = path.join(venv, "requirements.txt");
  const wanted = fs.readFileSync(requirements, "utf8");
  if (!fs.existsSync(installed) || fs.readFileSync(installed, "utf8") !== wanted) {
    fs.rmSync(venv, { recursive: true, force: true });
    sh("python3", ["-m", "venv", venv]);
    sh(path.join(venv, "bin/pip"), ["install", "--quiet", "--disable-pip-version-check", "--require-hashes", "--only-binary", ":all:", "-r", requirements]);
    fs.writeFileSync(installed, wanted);
  }
  return path.join(venv, "bin/dmgbuild");
}
