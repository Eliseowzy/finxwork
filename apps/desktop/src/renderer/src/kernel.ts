import { RpcClient, type Transport } from "@finx/client";
import { PROTOCOL_VERSION } from "@finx/protocol";

// The page's connection to finx (desktop-design §3.2). In the app it is the
// MessagePort the main process hands out, carrying NDJSON text as finx wrote
// it; a page previewed in a browser runs a mock server of its own.

function portTransport(): Promise<Transport> {
  return new Promise((resolve) => {
    const take = (e: MessageEvent) => {
      if (e.source !== window || e.data !== "finx-kernel" || !e.ports[0]) return;
      window.removeEventListener("message", take);
      const port = e.ports[0];
      const texts = new Set<(text: string) => void>();
      const closes = new Set<() => void>();
      // Text is protocol; anything else is the main process saying the connection ended.
      port.onmessage = (m) => (typeof m.data === "string" ? texts.forEach((f) => f(m.data)) : closes.forEach((f) => f()));
      resolve({
        send: (text) => port.postMessage(text),
        onText: (cb) => (texts.add(cb), () => void texts.delete(cb)),
        onClose: (cb) => (closes.add(cb), () => void closes.delete(cb)),
      });
    };
    window.addEventListener("message", take);
    window.finx!.connectKernel();
  });
}

/** A connection to finx, initialized. */
export async function connect(): Promise<{ rpc: RpcClient; server: string }> {
  const transport = window.finx ? await portTransport() : (await import("@finx/client/mock")).mockTransport();
  const rpc = new RpcClient(transport);
  const init = await rpc.request("initialize", {
    protocol_version: PROTOCOL_VERSION,
    client_info: { name: "finxwork", version: window.finx?.version },
  });
  return { rpc, server: `${init.server_info.name} ${init.server_info.version ?? ""}`.trim() };
}
