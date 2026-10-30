// One-time migration client for the retired Node gateway. Not used for model calls.
import net from "node:net";
import { EventEmitter } from "node:events";
export class Rpc extends EventEmitter {
  socket: net.Socket;
  seq = 0;
  buffer = "";
  pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(endpoint: string) {
    super();
    this.socket = net.createConnection(endpoint);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
        this.socket.destroy();
        return;
      }
      for (let i; (i = this.buffer.indexOf("\n")) >= 0; ) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this.socket.destroy();
          return;
        }
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          msg.error
            ? p.reject(new Error(msg.error.message || "RPC failed"))
            : p.resolve(msg.result);
        } else if (msg.method) this.emit("notification", msg);
      }
    });
    this.socket.on("error", () => {});
    this.socket.on("close", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Connection service disconnected"));
      }
      this.pending.clear();
      this.emit("closed");
    });
  }
  request(method: string, params: unknown = {}, timeout = 30000): Promise<any> {
    if (this.socket.destroyed)
      return Promise.reject(new Error("Connection closed"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Connection operation timed out"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  close() {
    this.socket.destroy();
  }
}
