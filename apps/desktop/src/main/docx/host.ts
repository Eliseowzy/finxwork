import { app, utilityProcess, type UtilityProcess } from "electron";
import net from "node:net";
import path from "node:path";
import { RpcClient } from "@finx/client";
import { PROTOCOL_VERSION, type DocxSerializeParams } from "@finx/protocol";
import { socketTransport } from "../kernel/supervisor";
import type { SerializeReply, SerializeRequest } from "./serializer";

// The app as the kernel's .docx writer (word-design §2): a connection of the main process's
// own that calls docx/host, then answers docx/serialize through the serializer process. The
// connection comes back whenever finx's service does; the process, whenever it is needed again.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keeps the app writing .docx for the kernel while it runs; `endpoint` waits for finx's service. */
export function startDocxHost(endpoint: () => Promise<string>, trace: (message: string) => void) {
  let stopped = false;
  const serializer = new Serializer(trace);
  app.on("before-quit", () => {
    stopped = true;
    serializer.stop();
  });
  void (async () => {
    while (!stopped) {
      try {
        await host(await endpoint(), serializer, trace);
      } catch (e) {
        trace(`docx host: ${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(1000);
    }
  })();
}

/** One connection, until it ends. */
async function host(endpoint: string, serializer: Serializer, trace: (message: string) => void) {
  const socket = net.createConnection(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.unref();
  const rpc = new RpcClient(socketTransport(socket));
  const closed = new Promise<void>((resolve) => rpc.onClose(resolve));
  socket.on("error", () => socket.destroy());
  try {
    await rpc.request("initialize", { protocol_version: PROTOCOL_VERSION, client_info: { name: "finxwork-docx", version: app.getVersion() } });
    rpc.handle("docx/serialize", async (params) => ({ bytes: await serializer.run(params) }));
    await rpc.request("docx/host", {} as never);
    trace("docx host: ready");
    await closed;
  } finally {
    socket.destroy();
  }
}

/** The serializer process, started on the first request and again after it dies. */
class Serializer {
  private child: UtilityProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (bytes: number) => void; reject: (e: Error) => void }>();

  private readonly trace: (message: string) => void;

  constructor(trace: (message: string) => void) {
    this.trace = trace;
  }

  run(params: DocxSerializeParams): Promise<number> {
    const child = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.postMessage({ id, params } satisfies SerializeRequest);
    });
  }

  stop() {
    this.child?.kill();
  }

  private start(): UtilityProcess {
    if (this.child) return this.child;
    // Built beside main/index.js (electron.vite.config.ts).
    const child = utilityProcess.fork(path.join(import.meta.dirname, "docx-serializer.js"), [], { serviceName: "FinxWork Word" });
    child.on("message", (reply: SerializeReply) => {
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      if ("error" in reply) p.reject(new Error(reply.error));
      else p.resolve(reply.bytes);
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      if (this.pending.size) this.trace(`docx serializer exited (${code}) with ${this.pending.size} waiting`);
      for (const p of this.pending.values()) p.reject(new Error(`the docx serializer exited (${code})`));
      this.pending.clear();
    });
    return (this.child = child);
  }
}
