#!/usr/bin/env node
// A drag selection in the Word editor keeps up with the pointer: after each move, by the next frame,
// the selection drawn over the page reaches the pointer, without waiting for the worker's answer.
//
//   node apps/desktop/e2e/word-drag.mjs
//   FINXWORK_E2E_NO_BUILD=1 …    uses the builds there are
import { execFileSync } from "node:child_process";
import path from "node:path";
import { check, setup, sleep, step } from "./lib/word.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const t = await setup({ prefix: "fxd-", respond: ({ ask, reply }) => reply(ask.includes("打开") ? "在这里：[报告](report.docx)" : "ok") });
// The right edge, in the window, of the selection drawn over the page, one frame after now.
const edge = `new Promise((done) => requestAnimationFrame(() => {
  const boxes = [...document.querySelectorAll(".fpn [data-docx-pages-host] > div[aria-hidden]")].filter((e) => e.style.background.startsWith("rgba(59, 130, 246"));
  done(boxes.length ? Math.max(...boxes.map((b) => b.getBoundingClientRect().right)) : null);
}))`;

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    execFileSync("cargo", ["build", "-p", "finx-cli"], { cwd: root, stdio: "inherit" });
    execFileSync("pnpm", ["--dir", desktop, "build"], { stdio: "inherit" });
  }
  const page = await t.launch();
  await t.openDocument(page, "报告");
  await sleep(1000);

  step("dragging across a line: each frame's selection reaches the pointer");
  const at = await page.lineOf("first");
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
  const lags = [];
  for (let i = 1; i <= 12; i++) {
    const x = at.x + ((at.x2 - at.x) * i) / 12;
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: at.y, button: "left", buttons: 1 });
    const right = await page.run(edge);
    lags.push(right === null ? Infinity : Math.round(x - right));
  }
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x2, y: at.y, button: "left", clickCount: 1 });
  console.log("pointer − selection edge, per move (px):", lags.join(" "));
  check(lags.every((lag) => lag < 30), `the selection trailed the pointer: ${lags.join(" ")}`);
  await sleep(500);
  const settled = await page.run(edge);
  check(settled !== null && Math.abs(at.x2 - settled) < 30, `after release the worker's selection is not where the drag ended: ${settled} vs ${at.x2}`);
  console.log("\n✔ a drag selection keeps up with the pointer");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await t.finish(failed);
}
process.exit(failed ? 1 : 0);
