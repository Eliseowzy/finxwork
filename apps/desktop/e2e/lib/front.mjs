// Watches which app is in front while scripts run behind the person's work: an app of this run
// coming forward is a failure, so the promise not to interrupt them stays true. macOS only.
import { execFile } from "node:child_process";

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 2000 }, (error, stdout) => resolve(error ? "" : stdout)));

async function frontPid() {
  const asn = (await run("lsappinfo", ["front"])).match(/ASN:\S+/)?.[0];
  if (!asn) return undefined;
  return Number((await run("lsappinfo", ["info", "-only", "pid", asn])).match(/\bpid\s*=\s*(\d+)/)?.[1]) || undefined;
}

/** The process itself, its parent and so on up. */
async function ancestors(pid) {
  const chain = [];
  while (pid > 1 && chain.length < 32) {
    chain.push(pid);
    pid = Number((await run("ps", ["-o", "ppid=", "-p", String(pid)])).trim()) || 0;
  }
  return chain;
}

/**
 * running() gives the pids of what runs now; onTaken(pid) hears of each one with an app that came
 * forward. Returns a function that stops watching.
 */
export function watchFront(running, onTaken) {
  if (process.platform !== "darwin") return () => {};
  let stopped = false;
  let last;
  void (async () => {
    while (!stopped) {
      const front = await frontPid();
      if (front && front !== last) {
        last = front;
        const chain = await ancestors(front);
        for (const pid of running()) if (chain.includes(pid)) onTaken(pid);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  return () => (stopped = true);
}
