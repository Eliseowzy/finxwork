import type { DocxSerializeParams } from "@finx/protocol";
import { serializeFiles } from "./serialize";

// The docx serializer process (a utilityProcess of the main process's, docx/host.ts): one
// request at a time, in order, each answered with its size or the error's message.

export type SerializeRequest = { id: number; params: DocxSerializeParams };
export type SerializeReply = { id: number; bytes: number } | { id: number; error: string };

let queue: Promise<void> = Promise.resolve();
process.parentPort.on("message", ({ data }: { data: SerializeRequest }) => {
  queue = queue.then(async () => {
    let reply: SerializeReply;
    try {
      reply = { id: data.id, bytes: await serializeFiles(data.params) };
    } catch (e) {
      reply = { id: data.id, error: e instanceof Error ? e.message : String(e) };
    }
    process.parentPort.postMessage(reply);
  });
});
