// One-time upgrade path. The new architecture never installs or starts a helper.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { finxHome } from "./kernel";
import { Rpc } from "./legacy-connections-client";
const exec = promisify(execFile);
export async function retireModelGateway() {
  if (process.platform !== "darwin") return;
  const home = finxHome;
  const label =
    "com.finxwork.model-connections." +
    crypto.createHash("sha256").update(home).digest("hex").slice(0, 12);
  const plist = path.join(
    os.homedir(),
    "Library/LaunchAgents",
    label + ".plist",
  );
  if (
    !(await fs.stat(plist).then(
      () => true,
      () => false,
    ))
  )
    return;
  const target = `gui/${process.getuid!()}/${label}`;
  const registered = await exec("/bin/launchctl", ["print", target]).then(
    () => true,
    () => false,
  );
  if (registered) {
    const rpc = new Rpc(path.join(home, "run/model-connections.sock"));
    try {
      await rpc.request("initialize", { protocol_version: 1 }, 5000);
      await rpc.request("service/drain");
      // Preserve ongoing model calls; the desktop upgrade waits for completion.
      for (;;) {
        const status = await rpc.request("service/status");
        if (!status.active_requests) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch {
      // A registered but crashed helper has no requests to drain.
      const status = await exec("/bin/launchctl", ["print", target]).catch(
        () => null,
      );
      if (status && /\bpid = \d+/.test(status.stdout))
        throw Error("旧模型网关仍在运行，暂时无法安全迁移");
    } finally {
      rpc.close();
    }
    await exec("/bin/launchctl", ["bootout", target]);
    let stopped = false;
    for (let i = 0; i < 100; i++) {
      if (
        !(await exec("/bin/launchctl", ["print", target]).then(
          () => true,
          () => false,
        ))
      ) {
        stopped = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!stopped) throw Error("正在等待旧模型网关退出");
  }
  const backup = path.join(home, "connections/legacy");
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  await fs.rename(plist, path.join(backup, label + ".plist.retired"));
  // Keep config, account bindings and Keychain sessions for the in-process adapter.
}
