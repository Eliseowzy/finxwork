import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The user's login environment, for the finx service the app starts
// (desktop-kernel-integration §7). An app opened from Finder or the Dock gets
// launchd's minimal environment — PATH is /usr/bin:/bin:/usr/sbin:/sbin, and
// nothing the user exports in their shell profile — while the commands finx
// runs for the model must find what they find in a terminal.

export type LoginEnvironment = {
  env: NodeJS.ProcessEnv;
  /** "login": read from the login shell; "fallback": the app's own, with the usual directories added. */
  source: "login" | "fallback";
  /** Why the fallback was used. */
  reason?: string;
  ms: number;
};

/** Variables that only describe the shell that printed them. */
const transient = ["FINXWORK_RESOLVING_ENVIRONMENT", "SHLVL", "_", "PWD", "OLDPWD"];

/**
 * The text between the two marks of `env -0` output, as variables. Anything a
 * profile prints (greetings, prompts) is outside the marks; values may hold
 * newlines, so entries are split on NUL only.
 */
export function parseEnv(output: string, mark: string): NodeJS.ProcessEnv | null {
  const start = output.indexOf(mark);
  const end = output.lastIndexOf(mark);
  if (start < 0 || end <= start) return null;
  const env: NodeJS.ProcessEnv = {};
  for (const entry of output.slice(start + mark.length, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  for (const name of transient) delete env[name];
  return env;
}

/** UTF-8 output from the commands finx runs, even when nothing chose a locale. */
export function withLocale(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env.LANG || env.LC_ALL ? env : { ...env, LANG: "en_US.UTF-8" };
}

/** The app's environment with the directories tools usually live in, for when the shell can't be asked. */
export function fallbackEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", path.join(home, ".cargo/bin"), path.join(home, ".local/bin")];
  const have = (base.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":");
  const add = extra.filter((d) => !have.includes(d) && fs.existsSync(d));
  return withLocale({ ...base, PATH: [...add, ...have].join(":") });
}

/**
 * Runs the login shell once — interactive and login, so both .zprofile and
 * .zshrc (or bash's, fish's) are read — and takes the environment it ends up
 * with. Ten seconds at most; otherwise the fallback.
 */
export function loginEnvironment(timeoutMs = 10_000): Promise<LoginEnvironment> {
  const started = Date.now();
  const shell = os.userInfo().shell || process.env.SHELL || "/bin/zsh";
  const mark = `__FINXWORK_${randomUUID().replaceAll("-", "")}__`;
  const command = `printf '%s' '${mark}'; /usr/bin/env -0; printf '%s' '${mark}'`;
  // The shell starts from the app's environment, minus Electron's own.
  const base: NodeJS.ProcessEnv = { ...process.env, FINXWORK_RESOLVING_ENVIRONMENT: "1" };
  for (const name of Object.keys(base)) if (name.startsWith("ELECTRON_")) delete base[name];
  return new Promise((resolve) => {
    const fallback = (reason: string) => resolve({ env: fallbackEnvironment(), source: "fallback", reason, ms: Date.now() - started });
    execFile(shell, ["-i", "-l", "-c", command], { env: base, cwd: os.homedir(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      const env = parseEnv(stdout ?? "", mark);
      if (env && env.PATH) return resolve({ env: withLocale(env), source: "login", ms: Date.now() - started });
      fallback(err ? (err.killed ? `${shell} took longer than ${timeoutMs} ms` : err.message) : `${shell} printed no environment`);
    }).stdin?.end();
  });
}
