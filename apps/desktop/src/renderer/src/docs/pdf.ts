import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";

// pdf.js for the document column (document-editor-design §7.3): it only shows pages and lets
// people select and search. Scripts never run; the bytes come from finxdoc://, a range at a
// time, so a 500-page report opens without being read whole.

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
// The viewer components read the library from here.
(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjs;

export { pdfjs };
export const viewerLib = () => import("pdfjs-dist/web/pdf_viewer.mjs");

/** pdf.js's data files beside the page (electron.vite.config.ts). */
const data = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

const chunk = 256 * 1024;

/** Fetches the ranges pdf.js asks for. */
class RangeTransport extends pdfjs.PDFDataRangeTransport {
  private url: string;

  constructor(url: string, length: number, initial: Uint8Array) {
    super(length, initial);
    this.url = url;
  }

  requestDataRange(begin: number, end: number) {
    fetch(this.url, { headers: { range: `bytes=${begin}-${end - 1}` } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => this.onDataRange(begin, new Uint8Array(b)))
      .catch(() => {});
  }
}

/** Opens the working copy a token stands for. */
export async function loadPdf(token: string, password?: string): Promise<pdfjs.PDFDocumentProxy> {
  const url = `finxdoc://${token}/current.pdf`;
  const first = await fetch(url, { headers: { range: `bytes=0-${chunk - 1}` } });
  if (!first.ok) throw new Error(`cannot read the document (HTTP ${first.status})`);
  const total = Number(/\/(\d+)$/.exec(first.headers.get("content-range") ?? "")?.[1] ?? first.headers.get("content-length"));
  const initial = new Uint8Array(await first.arrayBuffer());
  const common = {
    isEvalSupported: false,
    enableXfa: false,
    password,
    cMapUrl: data("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: data("standard_fonts"),
    wasmUrl: data("wasm"),
    rangeChunkSize: chunk,
  };
  const src = initial.length >= total ? { ...common, data: initial } : { ...common, range: new RangeTransport(url, total, initial) };
  return pdfjs.getDocument(src).promise;
}
