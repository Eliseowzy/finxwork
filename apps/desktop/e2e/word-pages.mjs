#!/usr/bin/env node
// Screenshots every page of a .docx as the Word editor draws it, for comparing with Word's own PDF.
//   DOCX=/path/to.docx FINXWORK_E2E_SHOTS=/tmp/out FINXWORK_E2E_NO_BUILD=1 node apps/desktop/e2e/word-pages.mjs
import fs from "node:fs";
import { setup, sleep, step } from "./lib/word.mjs";

const source = process.env.DOCX;
const t = await setup({ prefix: "fxp-", respond: ({ reply }) => reply("在这里：[文档](report.docx)") });
fs.copyFileSync(source, t.docx);
let failed = false;
try {
  const page = await t.launch();
  if (process.env.WORKER_LOG) {
    await page.cdp("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
    let n = 1000;
    const enabled = new Set();
    setInterval(() => {
      for (const e of page.events) if (e.method === "Target.attachedToTarget" && !enabled.has(e.params.sessionId)) {
        enabled.add(e.params.sessionId);
        page.cdp("Target.sendMessageToTarget", { sessionId: e.params.sessionId, message: JSON.stringify({ id: ++n, method: "Runtime.enable" }) }).catch(() => {});
      }
    }, 50);
  }
  if (process.env.IMG_PROBE) await page.cdp("Page.enable");
  if (process.env.IMG_PROBE) await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: '(() => { window.__imgs = []; const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src"); Object.defineProperty(HTMLImageElement.prototype, "src", { configurable: true, get() { return d.get.call(this); }, set(v) { const rec = { src: String(v).slice(0, 40) }; window.__imgs.push(rec); this.addEventListener("load", () => rec.ok = this.naturalWidth + "x" + this.naturalHeight); this.addEventListener("error", () => rec.ok = "error"); d.set.call(this, v); } }); const cib = window.createImageBitmap; window.createImageBitmap = function (...a) { const rec = { cib: String(a[0] && (a[0].type || a[0].constructor.name)) }; window.__imgs.push(rec); return cib.apply(this, a).then((r) => { rec.ok = 1; return r; }, (e) => { rec.ok = String(e); throw e; }); }; })()' });
  await t.openDocument(page, "文档");
  await page.run(`document.querySelector(".fpn")?.closest("[class*=split], .main")?.style; 0`);
  await page.run(`localStorage`); await page.click("button[aria-label*=最大], button[title*=最大], button[aria-label*=放大], button[title*=放大]").catch(() => {}); await sleep(3000);
  const probe = await page.run(`(() => {
    const c = document.querySelector(".fpn .word-editor-canvas");
    const s = [...document.querySelectorAll(".fpn *")].filter((e) => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    return { cls: s && [...s.children].map((e) => e.className + ":" + e.offsetHeight).slice(0, 5), canvases: document.querySelectorAll(".fpn .word-editor-canvas canvas").length, zoom: c.dataset.zoom, scroller: s && s.className, sh: s && s.scrollHeight, ch: s && s.clientHeight };
  })()`);
  console.log(JSON.stringify(probe));
  console.log("CANVAS", JSON.stringify(await page.run(`[...document.querySelectorAll(".fpn canvas")].slice(0, 4).map((c) => { try { return c.getContext("2d") ? "main" : "none"; } catch (e) { return "offscreen:" + e.name; } })`)));
  if (process.env.IMG_PROBE) {
    await page.run(`(() => { const s = document.querySelector(".docx-editor__scroll-container"); s.scrollTop = 18 * (s.scrollHeight - 16) / 41; })()`);
    await sleep(4000);
    if (process.env.WORKER_LOG) console.log(page.events.filter((e) => e.method === "Target.receivedMessageFromTarget").map((e) => JSON.parse(e.params.message)).filter((m) => m.method === "Runtime.consoleAPICalled").map((m) => m.params.args.map((a) => a.value ?? "").join(" ")).filter((l) => l.includes("IMGDBG")).slice(-12).join("\n"));
    console.log("IMGS", JSON.stringify(await page.run("window.__imgs")));
  }
  if (process.env.SVG_PROBE) {
    const b64 = fs.readFileSync(process.env.SVG_PROBE).toString("base64");
    console.log("SVGPROBE", JSON.stringify(await page.run(`(async () => { const i = new Image(); i.src = "data:image/svg+xml;base64,${b64}"; try { await i.decode(); return { ok: true, w: i.naturalWidth, h: i.naturalHeight }; } catch (e) { return { ok: false, e: String(e) }; } })()`)));
  }
  console.log("PAGES", await page.run(`document.body.innerText.match(/共 \\d+ 页/)?.[0] ?? ""`), await page.run(`document.querySelectorAll(".fpn [data-page-index]").length`));
  for (const f of [0.25, 0.5, 0.75, 1]) { await page.run(`(() => { const s = document.querySelector(".docx-editor__scroll-container"); s.scrollTop = s.scrollHeight * ${f}; })()`); await sleep(2500); }
  await sleep(4000);
  console.log("PAGES-AFTER", await page.run(`document.body.innerText.match(/共 \\d+ 页/)?.[0] ?? ""`));
  if (process.env.PROBE_ONLY) throw new Error("probe only");
  const total = Number(process.env.PAGES ?? 40);
  const H = (probe.sh - 16) / total;
  for (let i = 0; i < total; i++) {
    await page.run(`(() => { const c = document.querySelector(".fpn .word-editor-canvas"); const s = [...document.querySelectorAll(".fpn *")].filter((e) => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]; s.scrollTop = ${i * H}; })()`);
    await sleep(700);
    const r = await page.run(`(() => { const r = document.querySelector(".docx-editor__scroll-container").getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 }; })()`);
    const { data } = await page.cdp("Page.captureScreenshot", { format: "png", clip: r });
    fs.mkdirSync(process.env.FINXWORK_E2E_SHOTS, { recursive: true });
    fs.writeFileSync(`${process.env.FINXWORK_E2E_SHOTS}/p-${String(i + 1).padStart(2, "0")}.png`, Buffer.from(data, "base64"));
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await t.finish(failed);
}

process.exit(0);
