// uv (https://github.com/astral-sh/uv), the Python package and environment runner used by
// `spatial_script` (crates/finx-core/src/spatial_script.rs), carried in Contents/MacOS beside
// finx: one pinned release, each archive checked against its sha256, kept between builds in
// node_modules/.cache.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The release FinxWork ships; a new one needs the `.sha256` assets from `gh release view`. */
export const uvRelease = {
  version: "0.13.8",
  sha256: {
    arm64: "6b71028a6b904f2ae3340ef52e595512de807d06c0a20eaef2f692581b246558",
    x64: "a04c2ffeac28b2003a2c13caf538ab425fcd7def3e4a41571f4a8fb370a66af3",
  },
};

const targetTriple = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" };

/**
 * Path to the `uv` binary for `arch` (arm64 or x64) from `cache`; downloaded from the GitHub
 * release when not cached yet or when the cached digest differs.
 */
export function uvBinaryFor(arch, cache, release = uvRelease, download = curl) {
  const expected = release.sha256[arch];
  const triple = targetTriple[arch];
  if (!expected || !triple) throw new Error(`uv: no archive for ${arch}`);
  const dir = path.join(cache, release.version, arch);
  const bin = path.join(dir, "uv");
  const stamp = path.join(dir, "sha256");
  if (!fs.existsSync(bin) || !fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== expected) {
    fs.rmSync(dir, { recursive: true, force: true });
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "uv-"));
    try {
      const name = `uv-${triple}.tar.gz`;
      const archive = path.join(staging, name);
      download(`https://github.com/astral-sh/uv/releases/download/${release.version}/${name}`, archive);
      const got = sha256(archive);
      if (got !== expected) throw new Error(`uv ${release.version} ${arch}: the archive's sha256 is ${got}, expected ${expected}`);
      execFileSync("tar", ["-xzf", archive, "-C", staging]);
      const extracted = path.join(staging, `uv-${triple}`, "uv");
      if (!fs.existsSync(extracted)) throw new Error(`uv ${release.version} ${arch}: expected ${extracted} in archive`);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(extracted, bin);
      fs.chmodSync(bin, 0o755);
      fs.writeFileSync(stamp, expected);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  return bin;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function curl(url, to) {
  execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--output", to, url], { stdio: "inherit" });
}
