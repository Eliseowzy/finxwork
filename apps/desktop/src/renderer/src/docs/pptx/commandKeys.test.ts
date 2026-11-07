import assert from "node:assert/strict";
import { test } from "node:test";
import { candidates, matches, type KeyLike } from "./commandKeys.ts";

const key = (code: string, key: string, mods: Partial<KeyLike> = {}): KeyLike =>
  ({ code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("Mod is ⌘ on macOS and Ctrl elsewhere, modifiers must match exactly", () => {
  assert.ok(matches(key("KeyD", "d", { metaKey: true }), "Mod+D", true));
  assert.ok(!matches(key("KeyD", "d", { ctrlKey: true }), "Mod+D", true));
  assert.ok(matches(key("KeyD", "d", { ctrlKey: true }), "Mod+D", false));
  assert.ok(!matches(key("KeyD", "D", { metaKey: true, shiftKey: true }), "Mod+D", true));
  assert.ok(matches(key("KeyC", "C", { metaKey: true, shiftKey: true }), "Mod+Shift+C", true));
});

test("the physical key decides, not the shifted or option glyph", () => {
  assert.ok(matches(key("Period", ">", { metaKey: true, shiftKey: true }), "Mod+Shift+.", true));
  assert.ok(matches(key("KeyF", "ƒ", { metaKey: true, altKey: true }), "Mod+Alt+F", true));
  assert.ok(matches(key("Space", " ", { metaKey: true }), "Mod+Space", true));
  assert.ok(matches(key("F5", "F5"), "F5", true));
});

const commands = [
  { id: "duplicate", shortcut: "Mod+D" },
  { id: "selectAll", shortcut: "Mod+A" },
  { id: "bold", shortcut: "Mod+B" },
  { id: "link", shortcut: "Mod+K" },
  { id: "palette", shortcut: "Mod+K" },
];

test("the slide strip duplicates and deletes slides", () => {
  assert.deepEqual(candidates(key("KeyD", "d", { metaKey: true }), "strip", commands, true), ["duplicateSlide", "duplicate"]);
  assert.deepEqual(candidates(key("Backspace", "Backspace"), "strip", commands, true), ["deleteSlide"]);
  assert.deepEqual(candidates(key("Backspace", "Backspace"), "stage", commands, true), []);
});

test("inside text, object chords stay with the text", () => {
  assert.deepEqual(candidates(key("KeyA", "a", { metaKey: true }), "text", commands, true), []);
  assert.deepEqual(candidates(key("KeyA", "a", { metaKey: true }), "stage", commands, true), ["selectAll"]);
  assert.deepEqual(candidates(key("KeyB", "b", { metaKey: true }), "text", commands, true), ["bold"]);
});

test("a shared chord tries every owner in order", () => {
  assert.deepEqual(candidates(key("KeyK", "k", { metaKey: true }), "stage", commands, true), ["link", "palette"]);
});
