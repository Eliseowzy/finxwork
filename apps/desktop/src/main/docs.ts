import { protocol } from "electron";
import fs from "node:fs";
import { Readable } from "node:stream";
import { finxHome } from "./kernel";
import { parseRange, tokenFile } from "./doc-tokens";

// The bytes of documents open beside a conversation (document-editor-design §7.3):
// finxdoc://<token>/current.pdf. finx gives a page a token when it opens a document
// for it and keeps it as $FINX_HOME/docs/.tokens/<token>, holding the document's id;
// this only looks the token up and serves that document's working copy, never any
// other path, and never reads the PDF.

export const docScheme = {
  scheme: "finxdoc",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "range",
  "access-control-expose-headers": "content-range, content-length, accept-ranges",
  "cache-control": "no-store",
};

const notFound = () => new Response("not found", { status: 404, headers });

export function serveDocs() {
  protocol.handle("finxdoc", async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "GET, HEAD" } });
    const file = tokenFile(finxHome, req.url);
    if (!file) return notFound();
    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      return notFound();
    }
    const range = parseRange(req.headers.get("range"), size);
    if (range === "bad") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    const contentType = file.endsWith(".pdf") ? "application/pdf" : file.endsWith(".json") ? "application/json" : "application/octet-stream";
    const base = { ...headers, "content-type": contentType, "accept-ranges": "bytes" };
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: { ...base, "content-length": String(size) } });
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const body = size === 0 ? null : (Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream);
    return new Response(body, {
      status: range ? 206 : 200,
      headers: { ...base, "content-length": String(size === 0 ? 0 : end - start + 1), ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) },
    });
  });
}
