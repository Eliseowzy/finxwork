#!/usr/bin/env node
// A Word document in the real app (docs/desktop/word-design.md §7): a .docx opens in the file panel
// as the kernel's document, the first page is drawn, typing makes it unsaved, ⌘S writes the file
// through the desktop's serializer process and every part it did not touch stays byte for byte.
// Changed on disk meanwhile, the next save shows the conflict note; "重新载入" brings the outside's
// content in.
//
// A model server on this Mac only links the file. finx and the app are real.
//
//   node apps/desktop/e2e/word-editor.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/word-editor.mjs   also screenshots
//   FINXWORK_E2E_NO_BUILD=1 …    uses the builds there are
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { changedParts, check, fail, parts, runs, setup, sha, sleep, step } from "./lib/word.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

const t = await setup({ prefix: "fxe-", respond: ({ ask, reply }) => reply(ask.includes("打开") ? "在这里：[报告](report.docx)" : "ok") });
const TYPED = "新增的一句话";
const OUTSIDE = "外部改动";
const tabStatus = `document.querySelector(".fpn-tools .fpn-state")?.textContent.trim() ?? ""`;
const note = `document.querySelector(".fpn-note.warn")?.innerText ?? ""`;
const disk = () => parts(t.docx)["word/document.xml"].toString("utf8");

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  const page = await t.launch();

  step("the document opens in the panel: the Word editor, its first page drawn, no error");
  await t.openDocument(page, "报告");
  check(!(await page.run(`!!document.querySelector(".fpn .word-error")`)), `an error over the editor: ${await page.run(`document.querySelector(".fpn .word-error")?.innerText`)}`);
  check(!(await page.run(tabStatus)), `the tab says something before any edit: ${await page.run(tabStatus)}`);
  await page.shot("01-opened");
  await sleep(1000);
  const warned = page.fontWarnings();
  check(warned.length === 0, `the editor's fonts fell back: ${warned.join(" | ")}`);

  step("typing makes it unsaved; ⌘S writes the file: the new words in, every other part untouched");
  await page.pageAt(250, 120).then((p) => page.clickAt(p.x, p.y));
  await page.cdp("Input.insertText", { text: TYPED });
  await page.until("the tab says unsaved", `${tabStatus} === "未保存"`, 10000).catch(async (e) => fail(`${e.message}: ${await page.run(tabStatus)}`));
  check(sha(fs.readFileSync(t.docx)) === sha(t.original), "typing wrote the file before a save");
  await page.chord("s", "KeyS", 4);
  for (let i = 0; i < 100 && sha(fs.readFileSync(t.docx)) === sha(t.original); i++) await sleep(100);
  check(sha(fs.readFileSync(t.docx)) !== sha(t.original), `⌘S did not write the file: ${await page.run(note)} ${await page.run(tabStatus)}`);
  await page.until("the tab says saved", `${tabStatus} === "已保存"`, 10000).catch(async (e) => fail(`${e.message}: ${await page.run(tabStatus)} ${await page.run(note)}`));
  const orig = path.join(t.work, "original.docx");
  fs.writeFileSync(orig, t.original);
  const before = parts(orig), now = parts(t.docx);
  check(runs(now["word/document.xml"].toString("utf8")).includes(TYPED), `the saved document has the typed words: ${runs(now["word/document.xml"].toString("utf8"))}`);
  const changed = changedParts(before, now);
  check(JSON.stringify(changed) === JSON.stringify(["word/document.xml"]), `only the document part changed: ${JSON.stringify(changed)}`);
  check(now["word/styles.xml"].equals(before["word/styles.xml"]), "styles.xml changed");
  await page.shot("02-saved");

  step("changed outside, then edited again: the save shows the conflict; 重新载入 shows the outside's content");
  const outside = path.join(t.work, "outside.docx");
  execFileSync("python3", ["-I", "-c", `import sys, zipfile
src, dst, word = sys.argv[1:4]
with zipfile.ZipFile(src) as a, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as b:
    for i in a.infolist():
        d = a.read(i.filename)
        if i.filename == "word/document.xml":
            d = d.decode("utf8").replace("结论：风险可控。", word).encode("utf8")
        b.writestr(i.filename, d)`, t.docx, outside, OUTSIDE]);
  fs.copyFileSync(outside, t.docx);
  const outsideSha = sha(fs.readFileSync(t.docx));
  await page.pageAt(250, 120).then((p) => page.clickAt(p.x, p.y));
  await page.cdp("Input.insertText", { text: "再改一处" });
  await page.chord("s", "KeyS", 4);
  await page.until("the conflict note", `${note}.includes("文件在外部被修改")`, 20000).catch(async (e) => fail(`${e.message}: ${await page.run(tabStatus)} ${await page.run(`document.querySelector(".fpn-note")?.innerText`)}`));
  check(sha(fs.readFileSync(t.docx)) === outsideSha, "the save overwrote the outside's change");
  await page.shot("03-conflict");
  await page.run(`[...document.querySelectorAll(".fpn-note.warn button")].find((b) => b.textContent.includes("重新载入")).click()`);
  await page.until("the conflict gone", `!${note}`, 20000);
  await page.until("the editor drawn again", `!!document.querySelector(".fpn .word-editor-canvas canvas") && !document.querySelector(".fpn .word-opening-overlay")`, 60000);
  check(sha(fs.readFileSync(t.docx)) === outsideSha, "reloading wrote the file");
  check((await page.run(tabStatus)) !== "未保存", "the tab still says unsaved after reloading");
  // What the editor now holds is the kernel's document: another edit saves on top of the outside's text.
  await page.pageAt(250, 120).then((p) => page.clickAt(p.x, p.y));
  await page.cdp("Input.insertText", { text: "重载后" });
  await page.chord("s", "KeyS", 4);
  for (let i = 0; i < 100 && sha(fs.readFileSync(t.docx)) === outsideSha; i++) await sleep(100);
  const after = runs(disk());
  const why = `${after} | ${await page.run(tabStatus)} | ${await page.run(note)}`;
  check(after.includes(OUTSIDE) && after.includes("重载后") && !after.includes("再改一处"), `the save after reloading is built on the outside's content: ${why}`);
  await page.shot("04-reloaded");

  page.close();
  console.log("\n✔ a docx opens, takes typing, saves with every other part untouched, shows the conflict for an outside change and reloads it");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await t.finish(failed);
}
process.exit(failed ? 1 : 0);
