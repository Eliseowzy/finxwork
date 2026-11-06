// Isolated browser harness for the production presentation surface and its save lifecycle.
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { RpcClient } from "@finx/client";
import { PresentationLoading } from "../../src/renderer/src/docs/pptx/PresentationLoading";
import PresentationView from "../../src/renderer/src/docs/pptx/PresentationView";
import { PresentationDoc, fromBase64, type PresentationFile } from "../../src/renderer/src/docs/pptx/document";
import { i18n } from "../../src/shared/i18n";
import "../../src/renderer/src/styles/tokens.css";
import "../../src/renderer/src/styles/app.css";

const root = createRoot(document.getElementById("root")!);
const rpc = {
  request: async (method: string, params: unknown) => {
    const r = await fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
} as RpcClient;
let doc: PresentationDoc;
let visible = true;
function render() {
  root.render(<I18nextProvider i18n={i18n}>{visible && <PresentationView doc={doc} rpc={rpc} session="test" name="editor.pptx" />}</I18nextProvider>);
}
async function open() {
  doc?.dispose();
  const file = await rpc.request("pptx/read", { session_id: "test", path: "editor.pptx" }) as PresentationFile;
  doc = new PresentationDoc(file, (data, base_hash) => rpc.request("pptx/write", { session_id: "test", path: "editor.pptx", data, base_hash }), () => {});
  render();
}
await open();
Object.assign(window, { smoke: {
  get doc() { return doc; },
  previewLoading(options: Parameters<typeof PresentationLoading>[0]) {
    root.render(<I18nextProvider i18n={i18n}><PresentationLoading {...options} /></I18nextProvider>);
  },
  hide() { visible = false; render(); },
  show() { visible = true; render(); },
  open,
  setLanguage: (language: string) => i18n.changeLanguage(language),
  async text() {
    const { initWasm, inspectPresentation } = await import("@betteroffice/pptx");
    await initWasm();
    const file = await rpc.request("pptx/read", { session_id: "test", path: "editor.pptx" });
    return JSON.stringify(inspectPresentation(fromBase64(file.data), { includeMedia: false }));
  },
} });
