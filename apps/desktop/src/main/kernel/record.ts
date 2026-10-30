import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The finx service's record: one line of JSON in the lock file next to its
// socket (protocol-design §8.2, D-37). The app reads it only when it cannot
// talk to the service — an incompatible protocol, or no answer — to find the
// process and ask it to stop.

export type ServiceRecord = {
  pid: number;
  version: string;
  protocol_version: number;
  socket: string;
  exe?: string;
  started_at: string;
};

/** The lock file of a socket: same name, `.lock`. */
export function lockPath(socket: string): string {
  return path.join(path.dirname(socket), path.basename(socket, path.extname(socket)) + ".lock");
}

export function readRecord(socket: string): ServiceRecord | null {
  try {
    const record = JSON.parse(fs.readFileSync(lockPath(socket), "utf8")) as ServiceRecord;
    return typeof record.pid === "number" && record.pid > 0 ? record : null;
  } catch {
    return null;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The name of a process's executable, to make sure a record points at finx before signalling it. */
function commandOf(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }, (_err, stdout) => resolve((stdout ?? "").trim()));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Asks the recorded service to stop: SIGTERM (finx closes its sessions,
 * interrupting running tasks, and saves their logs), then SIGKILL if it is
 * still there after `graceMs`. Resolves to whether a finx process went away.
 */
export async function stopRecorded(socket: string, graceMs = 10_000): Promise<boolean> {
  const record = readRecord(socket);
  if (!record || !alive(record.pid)) return false;
  const name = path.basename(await commandOf(record.pid));
  if (name !== "finx") return false;
  process.kill(record.pid, "SIGTERM");
  for (let waited = 0; waited < graceMs; waited += 100) {
    if (!alive(record.pid)) return true;
    await sleep(100);
  }
  if (alive(record.pid)) process.kill(record.pid, "SIGKILL");
  return true;
}
