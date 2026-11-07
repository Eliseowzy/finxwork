#!/usr/bin/env node
// The AI in a Word document (docs/desktop/word-design.md §5, §7), in the real app. A model server
// on this Mac plays the agent; finx and the app are real.
//   1. A selection, ✦, 润色: the agent's docx_edit (suggest) shows in place as revisions of the author
//      FinxWork AI; "接受全部"; ⌘S writes the file with the new words and no w:ins / w:del.
//   2. In the conversation, docx_edit direct: asking for permissions, an approval card first, and
//      nothing changes until it is allowed; with edits accepted, no card. The step's 撤销 restores
//      the text in the editor.
//   3. A comment "@AI …" is answered with reply_comment in its thread.
//   4. docx_view returns a page as an image.
//
//   node apps/desktop/e2e/word-ai.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/word-ai.mjs   also screenshots
//   FINXWORK_E2E_NO_BUILD=1 …    uses the builds there are
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check, fail, parts, runs, setup, sha, sleep, step, text } from "./lib/word.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

const POLISHED = "收入同比增长 10%";
const DIRECT = "风险较低";
const REPLY = "这段概述了公司经营和收入增长。";
let lastTools = [];
let sawImage = false;

const t = await setup({
  prefix: "fxa-",
  images: true,
  respond: ({ messages, ask, done, reply, call, tools }) => {
    // The page comes back as a message of its own after the tool's result: the turn goes on from there.
    if (messages.some((m) => m.tool_calls?.some((c) => c.function.arguments.includes('"docx_view"')))) {
      lastTools = messages.filter((m) => m.role === "tool").map(text);
      const flat = JSON.stringify(messages);
      sawImage = /data:image\/png;base64/.test(flat) || /"image_url"/.test(flat);
      return reply("看过了。");
    }
    const docx = t.docx;
    // The paragraph ids a request names, or the outline's line holding some words.
    const named = ask.match(/"id":\s*"([^"]+)"/)?.[1];
    const outlineId = (words) => tools.join("\n").split("\n").map((l) => l.match(/^\[([^\]]+)\].*/)).find((m) => m && m[0].includes(words))?.[1];
    if (ask.includes("打开")) return reply("在这里：[报告](report.docx)");
    if (ask.includes('"action": "polish"')) {
      if (!done.includes("docx_edit")) return call("docx_edit", { docx, note: "润色这一段", edits: [{ op: "replace_text", paragraph: named, find: "收入增长了百分之十", replace: POLISHED }] });
      return reply("润色好了。");
    }
    if (ask.includes('"comment_id"')) {
      if (!done.includes("docx_read")) return call("docx_read", { docx, from: named, count: 1 });
      const comment = tools.join("\n").match(/comment (\S+) by [^:\n]*: @AI/)?.[1];
      if (!comment) return reply(`读不到批注：${tools.join("\n---\n").slice(0, 1500)}`);
      if (!done.includes("docx_edit")) return call("docx_edit", { docx, note: "回答批注", edits: [{ op: "reply_comment", comment, text: REPLY }] });
      return reply("已回复。");
    }
    if (ask.includes("直接改")) {
      if (!done.includes("docx_read")) return call("docx_read", { docx });
      const id = outlineId("结论");
      if (!id) return reply(`读不到结论：${tools.join("\n---\n").slice(0, 1500)}`);
      if (!done.includes("docx_edit")) return call("docx_edit", { docx, mode: "direct", note: "直接改结论", edits: [{ op: "replace_text", paragraph: id, find: "风险可控", replace: DIRECT }] });
      return reply("改好了。");
    }
    if (ask.includes("看一页")) {
      return call("docx_view", { docx, page: 1 });
    }
    reply("ok");
  },
});

const tabStatus = `document.querySelector(".fpn-tools .fpn-state")?.textContent.trim() ?? ""`;
const approval = `document.querySelector(".appr")`;
const steps = `[...document.querySelectorAll("[data-testid=docx-edit]")]`;
const disk = () => parts(t.docx)["word/document.xml"].toString("utf8");

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  const page = await t.launch();
  await t.openDocument(page, "报告");
  const text0 = await page.editorText();
  check(text0.includes("收入增长了百分之十") && text0.includes("风险可控"), `the editor's text: ${text0}`);

  step("a selection, ✦, 润色: the agent's revisions show in place, by FinxWork AI");
  await page.select("first");
  await page.until("the ✦", `!!document.querySelector(".word-ai-spark")`, 10000);
  await page.shot("01-selected");
  await page.click(".word-ai-spark");
  await page.until("the menu", `!!document.querySelector(".word-ai-menu")`, 10000);
  await page.run(`[...document.querySelectorAll(".word-ai-menu button")].find((b) => b.textContent.trim() === "润色").click()`);
  await page.until("the revisions beside the text", `(document.querySelector(".fpn")?.innerText ?? "").includes("FinxWork AI")`, 60000).catch(async (e) => fail(`${e.message}: ${await page.run(`document.querySelector(".cscroll")?.innerText.slice(-800)`)}`));
  await page.until("the request's bar: accept all", `[...document.querySelectorAll(".word-ai-bar button")].some((b) => b.textContent.trim() === "接受全部")`, 60000);
  check((await page.editorText()).includes(POLISHED), `the new words show in the editor: ${await page.editorText()}`);
  check(sha(fs.readFileSync(t.docx)) === sha(t.original), "the edit wrote the file before a save");
  await page.shot("02-revisions");
  await page.run(`[...document.querySelectorAll(".word-ai-bar button")].find((b) => b.textContent.trim() === "接受全部").click()`);
  await page.until("the bar gone", `!document.querySelector(".word-ai-bar")`, 20000);
  await page.until("no revision left in the sidebar", `!(document.querySelector(".fpn")?.innerText ?? "").includes("FinxWork AI")`, 20000).catch(async (e) => fail(`${e.message}: ${await page.run(`document.querySelector(".fpn")?.innerText.slice(0, 600)`)}`));
  await page.click(".word-editor-canvas");
  await page.chord("s", "KeyS", 4);
  for (let i = 0; i < 100 && sha(fs.readFileSync(t.docx)) === sha(t.original); i++) await sleep(100);
  check(sha(fs.readFileSync(t.docx)) !== sha(t.original), `⌘S did not write the file: ${await page.run(tabStatus)}`);
  const xml = disk();
  check(runs(xml).includes(POLISHED), `the file has the new words: ${runs(xml)}`);
  check(!/<w:(ins|del)[ >]/.test(xml), "the file still holds tracked changes");
  await page.until("the tab says saved", `${tabStatus} === "已保存"`, 10000);
  await page.shot("03-accepted-saved");

  step("asking for permissions: docx_edit direct asks first, and nothing changes until it is allowed");
  await t.say(page, "直接改结论");
  await page.until("the approval", `!!${approval}`, 30000).catch(async (e) => fail(`${e.message}: ${await page.run(`document.querySelector(".cscroll")?.innerText.slice(-1200)`)}`));
  check((await page.editorText()).includes("风险可控"), "the text changed before it was allowed");
  await page.shot("04-asked");
  await page.click(".appr .btn.primary");
  await page.until("the turn ended", `!document.querySelector(".working") && !${approval}`, 60000);
  await page.until("the change in the editor", `(await_text = [...document.querySelectorAll(".fpn .layout-run-text")].map((e) => e.textContent).join("")).includes(${JSON.stringify(DIRECT)})`, 20000).catch(async (e) => fail(`${e.message}: ${await page.editorText()}`));
  await page.until("its step offers 撤销", `${steps}.length >= 1 && !!${steps}.at(-1).querySelector(".deck-edit-undo")`, 10000);
  await page.run(`${steps}.at(-1).querySelector(".deck-edit-undo").click()`);
  await page.until("the step says undone", `!!${steps}.at(-1).querySelector(".deck-edit-done")`, 10000).catch(async (e) => fail(`${e.message}: ${await page.run(`${steps}.at(-1).innerText`)}`));
  await page.until("the original text back in the editor", `(await_text = [...document.querySelectorAll(".fpn .layout-run-text")].map((e) => e.textContent).join("")).includes("风险可控") && !await_text.includes(${JSON.stringify(DIRECT)})`, 20000).catch(async (e) => fail(`${e.message}: ${await page.editorText()}`));
  await page.shot("05-undone");

  step("edits accepted: docx_edit direct is made without a card");
  await t.setPermission("accept-edits");
  await t.ask(page, "直接改结论");
  check(!(await page.run(`!!${approval}`)), "an approval was asked under accepted edits");
  await page.until("the change in the editor", `[...document.querySelectorAll(".fpn .layout-run-text")].map((e) => e.textContent).join("").includes(${JSON.stringify(DIRECT)})`, 20000).catch(async (e) => fail(`${e.message}: ${await page.editorText()}`));
  await page.until("its step offers 撤销", `!!${steps}.at(-1).querySelector(".deck-edit-undo")`, 10000);
  await page.run(`${steps}.at(-1).querySelector(".deck-edit-undo").click()`);
  await page.until("the original text back", `![...document.querySelectorAll(".fpn .layout-run-text")].map((e) => e.textContent).join("").includes(${JSON.stringify(DIRECT)})`, 20000);

  step("a comment opening with @AI is answered in its thread");
  await page.select("first");
  // The selection has settled once ✦ shows for it; a menu opened before then acts on an older one.
  await page.until("the ✦", `!!document.querySelector(".word-ai-spark")`, 10000);
  await sleep(300);
  const line = await page.lineOf("first");
  // Inside the selection, so the menu acts on it.
  const at = { x: (line.x + line.x2) / 2, y: line.y };
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "right", clickCount: 1 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "right", clickCount: 1 });
  await page.until("the context menu", `[...document.querySelectorAll("[role=menuitem]")].some((e) => e.textContent.trim() === "批注")`, 10000);
  await page.run(`[...document.querySelectorAll("[role=menuitem]")].find((e) => e.textContent.trim() === "批注").click()`);
  await page.until("the comment box", `!!document.querySelector(".docx-comment-composer textarea")`, 10000);
  await page.run(`document.querySelector(".docx-comment-composer textarea").focus()`);
  await page.cdp("Input.insertText", { text: "@AI 这段什么意思" });
  await page.until("the 批注 button", `!document.querySelector(".docx-comment-composer .docx-review-button--primary").disabled`, 10000);
  await page.click(".docx-comment-composer .docx-review-button--primary");
  await page.until("the answer in the thread", `(document.querySelector(".docx-unified-sidebar")?.innerText ?? "").includes(${JSON.stringify(REPLY)})`, 60000).catch(async (e) => fail(`${e.message}: ${await page.run(`document.querySelector(".docx-unified-sidebar")?.innerText.slice(0, 600)`)} | ${await page.run(`document.querySelector(".cscroll")?.innerText.slice(-800)`)}`));
  await page.shot("06-comment-reply");

  step("docx_view returns a page as an image");
  await t.ask(page, "看一页");
  const failedStep = await page.run(`document.querySelector(".cscroll")?.innerText.includes("does not take images")`);
  check(!failedStep, "docx_view was refused");
  check(sawImage, `the model got an image back: ${JSON.stringify(lastTools).slice(0, 300)}`);
  check(lastTools.some((x) => /Page 1 of/.test(x)), `the tool answered with the page: ${lastTools.join(" | ").slice(0, 300)}`);

  page.close();
  console.log("\n✔ 润色 shows revisions of FinxWork AI and accepting and saving leaves none; direct edits are asked about, made, taken back with 撤销; @AI comments are answered; docx_view gives an image");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await t.finish(failed);
}
process.exit(failed ? 1 : 0);
