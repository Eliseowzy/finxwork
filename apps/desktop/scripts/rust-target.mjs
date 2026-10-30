// The Rust target a kernel for another architecture is built with, installed
// when missing (desktop-release.md §3): for the toolchain rust-toolchain.toml
// pins, so rustup is asked from the repository's root.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

export const rustTriples = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" };

export function ensureRustTarget(arch, root) {
  const triple = rustTriples[arch];
  const rustup = process.env.RUSTUP || [`${os.homedir()}/.cargo/bin/rustup`].find((p) => fs.existsSync(p)) || "rustup";
  let installed;
  try {
    installed = execFileSync(rustup, ["target", "list", "--installed"], { cwd: root, encoding: "utf8" }).split("\n");
  } catch {
    throw new Error(`cannot run rustup to check Rust's ${triple} target; set RUSTUP`);
  }
  if (installed.includes(triple)) return;
  console.log(`› installing Rust's ${triple} target, for the ${arch} kernel`);
  execFileSync(rustup, ["target", "add", triple], { cwd: root, stdio: "inherit" });
}
