#!/usr/bin/env node
// Export as PDF in the real app (word-design §6): with an unsaved edit in the document, the
// toolbar's PDF button opens the dialog; exporting writes a PDF of the document as it is now (the
// typed words in it, as text) and says how many pages. A page range
// past the end is refused with the reason.
//
//   node apps/desktop/e2e/word-pdf.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/word-pdf.mjs   also screenshots
//   FINXWORK_E2E_NO_BUILD=1 …    uses the builds there are
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check, fail, setup, sleep, step } from "./lib/word.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

const t = await setup({ prefix: "fxp-", respond: ({ ask, reply }) => reply(ask.includes("打开") ? "在这里：[报告](report.docx)" : "ok") });
const pdf = path.join(t.proj, "导出", "报告.pdf");
fs.mkdirSync(path.dirname(pdf), { recursive: true });
process.env.FINXWORK_E2E_SAVE_TO = pdf;
const TYPED = "导出前新增的句子";
const dialog = `(document.querySelector(".word-dialog")?.innerText ?? "")`;
const click = (selector) => `(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = b.at(-1); el?.click(); return !!el; })()`;
const clickText = (text) => `(() => { const b = [...document.querySelectorAll(".word-dialog button")].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); b?.click(); return !!b; })()`;

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  const page = await t.launch();
  await t.openDocument(page, "报告");

  step("an unsaved edit, then the toolbar's PDF button opens the dialog");
  await page.pageAt(250, 120).then((p) => page.clickAt(p.x, p.y));
  await page.cdp("Input.insertText", { text: TYPED });
  await sleep(500);
  const found = await page.run(click('.fpn button[title="导出为 PDF"], .fpn [aria-label="导出为 PDF"]'));
  if (!found) fail(`no PDF button in the toolbar: ${await page.run(`[...document.querySelectorAll(".fpn .word-surface button")].slice(0, 12).map((b) => b.title || b.getAttribute("aria-label") || b.textContent.trim()).join(" | ")`)}`);
  await page.until("the dialog", `${dialog}.includes("页面范围")`, 5000);
  await page.shot("01-dialog");

  step("a range past the end is refused with the reason");
  await page.run(`(() => { const i = document.querySelectorAll(".word-dialog input[type=number]"); const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }; set(i[0], "5"); set(i[1], "6"); })()`);
  check(await page.run(clickText("导出…")), "no export button");
  await page.until("the refusal", `${dialog}.includes("导出失败")`, 90000).catch(async (e) => fail(`${e.message}: ${await page.run(dialog)}`));
  check((await page.run(dialog)).includes("页码超出范围"), `the refusal does not say why: ${await page.run(dialog)}`);
  check(!fs.existsSync(pdf), "a refused export wrote a file");

  step("all pages: the PDF is written, with the unsaved words as text");
  await page.run(`document.querySelector(".word-dialog input[type=radio]").click()`);
  if (!(await page.run(clickText("导出…")))) fail(`no export button: ${await page.run(dialog)}`);
  await page.until("the result", `${dialog}.includes("已导出")`, 120000).catch(async (e) => fail(`${e.message}: ${await page.run(dialog)}`));
  await page.shot("02-done");
  check(fs.readFileSync(pdf).subarray(0, 5).toString() === "%PDF-", "not a PDF");
  const text = execFileSync("pdftotext", [pdf, "-"]).toString("utf8");
  check(text.includes(TYPED), `the PDF lacks the unsaved words: ${text.slice(0, 200)}`);
  check(await page.run(clickText("完成")), "no done button");
  check(!(await page.run(`!!document.querySelector(".word-dialog")`)), "the dialog stayed open");

  page.close();
  console.log("\n✔ the PDF button exports the document as it is now, and refuses a range past its end");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await t.finish(failed);
}
process.exit(failed ? 1 : 0);
