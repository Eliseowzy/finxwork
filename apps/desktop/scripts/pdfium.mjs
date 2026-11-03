// PDFium (https://github.com/bblanchon/pdfium-binaries), the library finx's document worker loads
// (crates/finx-docs), as FinxWork carries it in Contents/Frameworks: one pinned release, each
// archive checked against its sha256, kept between builds in node_modules/.cache.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The release FinxWork ships (its VERSION: 156.0.8076.0); a new one needs the archives' digests from `gh release view`. */
export const pdfiumRelease = {
  tag: "chromium/8076",
  sha256: {
    arm64: "0d6781fe08906baff3d82c90953e519fbc4eb253fe76431e5ed53b157763b97c",
    x64: "40865f34642c34d82cc336132df9e0347133f4692cd46776647af160f9a5cca9",
  },
};

export const pdfiumLibrary = "libpdfium.dylib";

/** The archive's name for `arch` (arm64 or x64). */
const archiveName = (arch) => `pdfium-mac-${arch}.tgz`;

/**
 * libpdfium.dylib for `arch` from `cache`; downloaded from the release (or taken from the copy
 * `tools/pdfium` holds, when its digest matches) when not there yet.
 */
export function pdfiumLibraryFor(arch, cache, root, release = pdfiumRelease, download = curl) {
  const expected = release.sha256[arch];
  if (!expected) throw new Error(`PDFium: no archive for ${arch}`);
  const dir = path.join(cache, release.tag.replace(/\W/g, "-"), arch);
  const lib = path.join(dir, "lib", pdfiumLibrary);
  const stamp = path.join(dir, "sha256");
  if (!fs.existsSync(lib) || !fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== expected) {
    fs.rmSync(dir, { recursive: true, force: true });
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "pdfium-"));
    try {
      const local = path.join(root, "tools/pdfium", archiveName(arch));
      let archive = local;
      if (!fs.existsSync(local) || sha256(local) !== expected) {
        archive = path.join(staging, archiveName(arch));
        download(`https://github.com/bblanchon/pdfium-binaries/releases/download/${release.tag}/${archiveName(arch)}`, archive);
      }
      const got = sha256(archive);
      if (got !== expected) throw new Error(`PDFium ${release.tag} ${arch}: the archive's sha256 is ${got}, expected ${expected}`);
      fs.mkdirSync(dir, { recursive: true });
      execFileSync("tar", ["-xzf", archive, "-C", dir]);
      fs.writeFileSync(stamp, expected);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  return lib;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function curl(url, to) {
  execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--output", to, url], { stdio: "inherit" });
}
