#!/usr/bin/env node
// A look at the Word editor (docs/desktop/word-design.md): screenshots of each state, light and dark,
// for a person to judge. Checks nothing beyond reaching each state.
//
//   FINXWORK_E2E_SHOTS=/tmp/word-polish/after node apps/desktop/e2e/word-look.mjs
//   THEMES=dark …   only one theme;  FINXWORK_E2E_NO_BUILD=1 …   uses the builds there are
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setup, sleep, step } from "./lib/word.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const out = process.env.FINXWORK_E2E_SHOTS ?? "/tmp/word-polish/look";
const themes = (process.env.THEMES ?? "light,dark").split(",");

if (!process.env.FINXWORK_E2E_NO_BUILD) {
  execFileSync("cargo", ["build", "-p", "finx-cli"], { cwd: root, stdio: "inherit" });
  execFileSync("pnpm", ["--dir", desktop, "build"], { stdio: "inherit" });
}

for (const theme of themes) {
  const shots = path.join(out, theme);
  process.env.FINXWORK_E2E_SHOTS = shots;
  const t = await setup({
    prefix: "fxl-",
    permission: "accept-edits",
    respond: ({ ask, done, reply, call, tools }) => {
      const docx = t.docx;
      const named = ask.match(/"id":\s*"([^"]+)"/)?.[1];
      if (ask.includes("打开只读")) return reply("在这里：[只读](locked.docx)");
      if (ask.includes("打开旧版")) return reply("在这里：[旧版](old.doc)");
      if (ask.includes("打开")) return reply("在这里：[报告](report.docx)");
      if (ask.includes('"action"')) {
        // Slow, so the shimmer and "working" can be seen.
        if (!done.includes("docx_edit")) return void setTimeout(() => call("docx_edit", { docx, note: "润色这一段", edits: [{ op: "replace_text", paragraph: named, find: "收入增长了百分之十", replace: "收入同比增长 10%" }] }), 4000);
        return reply("润色好了。");
      }
      if (ask.includes("直接改")) {
        if (!done.includes("docx_read")) return call("docx_read", { docx });
        const id = tools.join("\n").split("\n").map((l) => l.match(/^\[([^\]]+)\].*/)).find((m) => m && m[0].includes("结论"))?.[1];
        if (!done.includes("docx_edit")) return call("docx_edit", { docx, mode: "direct", note: "直接改结论", edits: [{ op: "replace_text", paragraph: id, find: "风险可控", replace: "风险较低" }] });
        return reply("改好了。");
      }
      if (ask.includes("建议改")) {
        if (!done.includes("docx_read")) return call("docx_read", { docx });
        const id = tools.join("\n").split("\n").map((l) => l.match(/^\[([^\]]+)\].*/)).find((m) => m && m[0].includes("结论"))?.[1];
        if (!done.includes("docx_edit")) return call("docx_edit", { docx, note: "建议改结论", edits: [{ op: "replace_text", paragraph: id, find: "风险可控", replace: "风险整体可控" }] });
        return reply("给了修订建议。");
      }
      reply("ok");
    },
  });
  fs.copyFileSync(t.docx, path.join(t.proj, "locked.docx"));
  fs.chmodSync(path.join(t.proj, "locked.docx"), 0o444);
  fs.writeFileSync(path.join(t.proj, "old.doc"), Buffer.from("d0cf11e0a1b11ae1", "hex"));
  let failed = false;
  try {
    step(`${theme}: opening`);
    const page = await t.launch();
    await page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await t.openDocument(page, "报告");
    await sleep(800);
    await page.shot("01-opened");

    step("✦ and its menu");
    await page.select("first");
    await page.until("the ✦", `!!document.querySelector(".word-ai-spark")`, 10000);
    await page.shot("02-spark");
    await page.click(".word-ai-spark");
    await page.until("the menu", `!!document.querySelector(".word-ai-menu")`, 10000);
    await page.shot("03-menu");
    await page.chord("Escape", "Escape", 0);

    step("⌘J, working, the result");
    await page.select("first");
    await page.chord("j", "KeyJ", 4);
    await page.until("the prompt", `!!document.querySelector(".word-ai-prompt input")`, 10000);
    await page.cdp("Input.insertText", { text: "改得正式一点" });
    await page.shot("04-prompt");
    await page.run(`document.querySelector(".word-ai-prompt").requestSubmit()`);
    await page.until("working", `!!document.querySelector(".word-ai-shimmer")`, 10000);
    await sleep(500);
    await page.shot("05-working");
    await page.until("accept all", `[...document.querySelectorAll(".word-ai-bar button")].length > 1`, 60000);
    await sleep(800);
    await page.shot("06-revisions");
    await page.run(`[...document.querySelectorAll(".word-ai-bar button")].find((b) => b.textContent.trim() === "拒绝全部" || b.textContent.trim() === "Reject all")?.click()`);
    await sleep(500);

    step("the conversation's steps");
    await t.ask(page, "直接改结论");
    await t.ask(page, "建议改结论");
    await sleep(800);
    await page.shot("07-steps");

    step("a comment");
    await page.select("first");
    await page.until("the ✦", `!!document.querySelector(".word-ai-spark")`, 10000);
    await sleep(300);
    const line = await page.lineOf("first");
    const at = { x: (line.x + line.x2) / 2, y: line.y };
    await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "right", clickCount: 1 });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "right", clickCount: 1 });
    await page.until("the context menu", `[...document.querySelectorAll("[role=menuitem]")].some((e) => /^(Comment|批注|评论)$/.test(e.textContent.trim()))`, 10000);
    await page.run(`[...document.querySelectorAll("[role=menuitem]")].find((e) => /^(Comment|批注|评论)$/.test(e.textContent.trim())).click()`);
    await page.until("the comment box", `!!document.querySelector(".docx-comment-composer textarea")`, 10000);
    await page.run(`document.querySelector(".docx-comment-composer textarea").focus()`);
    await page.cdp("Input.insertText", { text: "这里的数字需要再核对一下" });
    await page.shot("08-comment-compose");
    await page.click(".docx-comment-composer .docx-review-button--primary");
    await sleep(800);
    await page.shot("09-comment");

    step("a conflict");
    const stat = fs.statSync(t.docx);
    fs.utimesSync(t.docx, new Date(), new Date(stat.mtimeMs + 5000));
    fs.appendFileSync(t.docx, Buffer.alloc(0));
    execFileSync("python3", ["-I", "-c", "import sys,zipfile,shutil\nsrc=sys.argv[1]\nz=zipfile.ZipFile(src);d={n:z.read(n) for n in z.namelist()};z.close()\nd['word/document.xml']=d['word/document.xml'].replace('结论'.encode(),'总结'.encode())\nw=zipfile.ZipFile(src,'w',zipfile.ZIP_DEFLATED)\n[w.writestr(n,b) for n,b in d.items()];w.close()", t.docx]);
    await page.pageAt(250, 120).then((p) => page.clickAt(p.x, p.y));
    await page.cdp("Input.insertText", { text: "再改" });
    await page.chord("s", "KeyS", 4);
    await page.until("the conflict", `!!document.querySelector(".fpn-note.warn")`, 20000).catch(() => {});
    await page.shot("10-conflict");

    step("read-only, loading, .doc");
    await t.say(page, "打开只读");
    const chip = (label) => `[...document.querySelectorAll(".am .fref")].find((c) => c.textContent.includes(${JSON.stringify(label)}))`;
    await page.until("the link", `!!${chip("只读")}`, 30000);
    await page.run(`${chip("只读")}.click()`);
    await page.until("loading", `!!document.querySelector(".fpn .pptx-load")`, 10000).catch(() => {});
    await page.shot("11-loading");
    await page.until("read-only", `!!document.querySelector(".fpn .word-readonly")`, 60000);
    await sleep(1500);
    await page.shot("12-readonly");
    await t.say(page, "打开旧版");
    await page.until("the link", `!!${chip("旧版")}`, 30000);
    await page.run(`${chip("旧版")}.click()`);
    await sleep(2500);
    await page.shot("13-doc");
    page.close();
  } catch (e) {
    failed = true;
    console.error(`\n✘ ${e.message}`);
  } finally {
    await t.finish(failed);
  }
  if (failed) process.exit(1);
}
console.log(`\n✔ screenshots in ${out}`);
