// What the running engine can do, detected at runtime. Each command lists the capabilities it
// needs; a missing one greys the command with "waiting for the engine" instead of failing.
//
// When the NimbleOffice fork ships a new interface, wire it here and nothing else changes:
//   • a method on the editor access (`handleAsync()`): add it to ACCESS (detected by presence);
//   • a new `applyEdits` step: add the op to EDIT_OPS_0_5_1's successor below;
//   • a new `formatText` patch key: add it to TEXT_KEYS in textStyle.ts and here.
// Pending entries name the interface we expect, so the fork engineer can grep for TODO(engine).

export type Capability =
  // Present in 0.5.1.
  | "builtin" | "edit.text" | "edit.format" | "edit.align" | "edit.rect" | "edit.fill" | "edit.stroke" | "edit.background"
  | "access.removeShape" | "access.zOrder" | "access.insertSlide" | "access.deleteSlide" | "access.moveSlide" | "access.table"
  // Detected by method presence on the access; absent in 0.5.1.
  | "access.duplicateSlide" | "access.setSlideLayout" | "access.layouts" | "access.addShape" | "access.addTextBox" | "access.addPicture"
  | "access.setShapeName" | "access.setShapeHidden" | "access.groupShapes" | "access.ungroupShapes"
  | "access.setShapeTransform" | "access.setParagraphProperties" | "access.setTextBodyProperties"
  | "access.setPictureCrop" | "access.mergeTableCells" | "access.setTableCellStyle" | "access.setHyperlink"
  | "access.sections" | "access.setHeaderFooter" | "access.copyShapes" | "access.pasteShapes"
  | "access.setSlideTransition" | "access.setAnimations" | "access.setSlideSize" | "access.applyTheme" | "access.resetSlide"
  | "access.insertTable" | "access.insertChart"
  // Text style keys `formatText` does not take yet.
  | "text.strike" | "text.highlight" | "text.caps"
  // Front end only; always present.
  | "host";

/** Capability → the access method whose presence turns it on. */
const ACCESS: Partial<Record<Capability, string>> = {
  "access.removeShape": "removeShape",
  "access.zOrder": "bringShapeToFront",
  "access.insertSlide": "insertSlide",
  "access.deleteSlide": "deleteSlide",
  "access.moveSlide": "moveSlide",
  "access.table": "insertTableRow",
  "access.duplicateSlide": "duplicateSlide",
  "access.setSlideLayout": "setSlideLayout",
  "access.layouts": "layouts",
  "access.addShape": "addShape",
  "access.addTextBox": "addTextBox",
  "access.addPicture": "addPicture",
  // TODO(engine): the names below are the ones we expect from the fork; adjust when it lands.
  "access.setShapeName": "setShapeName",
  "access.setShapeHidden": "setShapeHidden",
  "access.groupShapes": "groupShapes",
  "access.ungroupShapes": "ungroupShapes",
  "access.setShapeTransform": "setShapeTransform",
  "access.setParagraphProperties": "setParagraphProperties",
  "access.setTextBodyProperties": "setTextBodyProperties",
  "access.setPictureCrop": "setPictureCrop",
  "access.mergeTableCells": "mergeTableCells",
  "access.setTableCellStyle": "setTableCellStyle",
  "access.setHyperlink": "setHyperlink",
  "access.sections": "setSections",
  "access.setHeaderFooter": "setHeaderFooter",
  "access.copyShapes": "copyShapes",
  "access.pasteShapes": "pasteShapes",
  "access.setSlideTransition": "setSlideTransition",
  "access.setAnimations": "setAnimations",
  "access.setSlideSize": "setSlideSize",
  "access.applyTheme": "applyTheme",
  "access.resetSlide": "resetSlide",
  "access.insertTable": "insertTable",
  "access.insertChart": "insertChart",
};

/** `applyEdits` ops of NimbleOffice 0.5.1, mapped to capabilities. */
const EDIT_CAPS: Capability[] = ["edit.text", "edit.format", "edit.align", "edit.rect", "edit.fill", "edit.stroke", "edit.background"];

/** Text keys the engine's `formatText` accepts beyond 0.5.1's set. TODO(engine): strike, highlight, caps. */
export const TEXT_CAPS: Partial<Record<Capability, string>> = {};

export function detectCapabilities(access: object | null): Set<Capability> {
  const caps = new Set<Capability>(["host", "builtin", ...EDIT_CAPS]);
  if (access) {
    for (const [cap, method] of Object.entries(ACCESS) as [Capability, string][]) {
      if (typeof (access as Record<string, unknown>)[method] === "function") caps.add(cap);
    }
  }
  for (const cap of Object.keys(TEXT_CAPS) as Capability[]) caps.add(cap);
  return caps;
}

export const accessMethod = (cap: Capability) => ACCESS[cap] ?? null;
