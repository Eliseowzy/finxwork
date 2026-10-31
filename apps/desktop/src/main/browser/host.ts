import net from "node:net";
import { app } from "electron";
import { RpcClient } from "@finx/client";
import { PROTOCOL_VERSION } from "@finx/protocol";
import { socketTransport } from "../kernel/supervisor";
import { electronPages } from "./pages";
import { EmbeddedBrowser } from "./shim";

// The app as finx's embedded browser (browser-design §8.3.1): a connection of the main
// process's own that calls browser/host, then carries CDP as browser/cdp notifications.
// Each browser the kernel starts on it has a stream number; a new number is a new browser,
// and the one before is gone. The connection comes back whenever finx's service does.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keeps the app hosting browsers while it runs; `endpoint` waits for finx's service. */
export function startBrowserHost(endpoint: () => Promise<string>, trace: (message: string) => void) {
  let stopped = false;
  app.on("before-quit", () => (stopped = true));
  void (async () => {
    while (!stopped) {
      try {
        await host(await endpoint(), trace);
      } catch (e) {
        trace(`browser host: ${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(1000);
    }
  })();
}

/** One connection, until it ends. */
async function host(endpoint: string, trace: (message: string) => void) {
  const socket = net.createConnection(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  // The app's life does not hang on this connection.
  socket.unref();
  const rpc = new RpcClient(socketTransport(socket));
  const closed = new Promise<void>((resolve) => rpc.onClose(resolve));
  socket.on("error", () => socket.destroy());
  const live: { current: { stream: number; browser: EmbeddedBrowser } | null } = { current: null };
  try {
    const init = await rpc.request("initialize", { protocol_version: PROTOCOL_VERSION, client_info: { name: "finxwork-browser", version: app.getVersion() } });
    if (!init.capabilities.embedded_browser) {
      trace("browser host: this finx has no embedded browser");
      await closed;
      return;
    }
    rpc.on("browser/cdp", ({ stream, data }) => {
      if (live.current?.stream !== stream) {
        live.current?.browser.close();
        live.current = { stream, browser: new EmbeddedBrowser(electronPages, (out) => rpc.notify("browser/cdp", { stream, data: out })) };
      }
      live.current.browser.receive(data);
    });
    await rpc.request("browser/host", {} as never);
    trace("browser host: ready");
    await closed;
  } finally {
    live.current?.browser.close();
    socket.destroy();
  }
}
