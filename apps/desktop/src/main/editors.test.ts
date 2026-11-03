import assert from "node:assert/strict";
import { test } from "node:test";
import { known, launchOf, opensFolders, parseFound, type Editor } from "./editors.ts";

const home = "/Users/me";

test("Spotlight's answer gives one app per editor, the one in Applications first", () => {
  const out = [
    "/Users/me/Downloads/Visual Studio Code.app   kMDItemCFBundleIdentifier = com.microsoft.VSCode",
    "/Applications/Visual Studio Code.app   kMDItemCFBundleIdentifier = com.microsoft.VSCode",
    "/Users/me/Applications/IntelliJ IDEA.app   kMDItemCFBundleIdentifier = com.jetbrains.intellij",
    "/Applications/Xcode.app/Contents/Applications/Instruments.app   kMDItemCFBundleIdentifier = com.apple.dt.Xcode",
    "/Users/me/.Trash/Zed.app   kMDItemCFBundleIdentifier = dev.zed.Zed",
    "/System/Applications/TextEdit.app   kMDItemCFBundleIdentifier = com.apple.TextEdit",
    "",
    "not a line",
  ].join("\n");
  assert.deepEqual(parseFound(out, home), [
    { id: "com.microsoft.VSCode", path: "/Applications/Visual Studio Code.app" },
    { id: "com.jetbrains.intellij", path: "/Users/me/Applications/IntelliJ IDEA.app" },
    { id: "com.apple.TextEdit", path: "/System/Applications/TextEdit.app" },
  ]);
});

const editor = (family: Editor["family"], more: Partial<Editor> = {}): Editor => ({ id: "x", name: "X", path: "/Applications/X.app", family, ...more });

test("each family is told the line its own way, never through a shell", () => {
  const file = "/Users/me/My Notes/报告 #1.md";
  assert.deepEqual(launchOf(editor("vscode", { scheme: "vscode" }), file, 42), { url: "vscode://file/Users/me/My%20Notes/%E6%8A%A5%E5%91%8A%20%231.md:42:1" });
  assert.deepEqual(launchOf(editor("vscode", { scheme: "cursor" }), "/a/b.ts"), { url: "cursor://file/a/b.ts" });
  assert.deepEqual(launchOf(editor("jetbrains", { program: "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea" }), "/a/b.kt", 7), {
    program: "/usr/bin/open",
    args: ["-na", "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea", "--args", "--line", "7", "/a/b.kt"],
  });
  assert.deepEqual(launchOf(editor("xcode"), "/a/b.swift", 3), { program: "/usr/bin/xed", args: ["--line", "3", "/a/b.swift"] });
  assert.deepEqual(launchOf(editor("xcode"), "/a/b.swift"), { program: "/usr/bin/open", args: ["-a", "/Applications/X.app", "/a/b.swift"] });
  assert.deepEqual(launchOf(editor("cli", { program: "/Applications/Zed.app/Contents/MacOS/cli" }), "/a/b.rs", 9), { program: "/Applications/Zed.app/Contents/MacOS/cli", args: ["/a/b.rs:9"] });
  assert.deepEqual(launchOf(editor("plain"), "/a/b.md", 9), { program: "/usr/bin/open", args: ["-a", "/Applications/X.app", "/a/b.md"] });
  // A family missing its part opens the file without the line.
  assert.deepEqual(launchOf(editor("vscode"), "/a/b.ts", 2), { program: "/usr/bin/open", args: ["-a", "/Applications/X.app", "/a/b.ts"] });
});

test("the editors looked for, and which open folders", () => {
  assert.equal(known["com.microsoft.VSCode"], "vscode");
  assert.equal(known["com.qoder.app"], "vscode");
  assert.equal(known["com.jetbrains.intellij"], "jetbrains");
  assert.ok(opensFolders(editor("vscode")) && opensFolders(editor("jetbrains")) && opensFolders(editor("cli")));
  assert.ok(!opensFolders(editor("plain")) && !opensFolders(editor("xcode")));
});
