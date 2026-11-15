// The BetterOffice adapter: the one module that calls `PptxAsyncEditorApi`. Everything above it
// (commands, ribbon, palette, AI) speaks `Engine`. When the editor moves to a kernel-held
// document, replace this file's internals; the `Engine` contract stays.
import type { PptxEditStep, PptxFindMatch } from "@nimbleoffice/pptx";
import type { PptxAsyncEditorAccess, PptxAsyncEditorApi, PptxCommandArgs, PptxCommandId, PptxPluginContext } from "@nimbleoffice/pptx-react";
import type { Rect } from "./geometry.ts";
import type { Engine, Host, TextRange } from "./types.ts";

export class EditRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export type PlacementSurface = {
  /** The plugin context of the presented slide, for EMU → overlay geometry. */
  context(): PptxPluginContext<unknown> | null;
  /** The overlay layer's client origin. */
  overlayOrigin(): { left: number; top: number } | null;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createEngine(api: PptxAsyncEditorApi, host: Host, surface: PlacementSurface): Engine {
  let accessPromise: Promise<PptxAsyncEditorAccess> | null = null;
  const access = () => accessPromise ??= api.handleAsync();
  const slideNumber = async (slideId: string) => (await access().then((a) => a.snapshot())).slides.findIndex((s) => s.id === slideId) + 1;

  const engine: Engine = {
    host,
    access,
    async builtin<K extends PptxCommandId>(id: K, args: PptxCommandArgs[K]) {
      const result = await api.commands.execute(id, args);
      if (!result.ok) throw new EditRefused(result.failure.code, result.failure.message);
    },
    async edit(steps: readonly PptxEditStep[]) {
      if (!steps.length) return;
      // A stale edit must be recomputed from a fresh snapshot. Retrying the same
      // steps against a newer version can overwrite a concurrent user edit.
      const result = await api.applyEdits({ expectVersion: await api.version(), steps });
      if (!result.ok) throw new EditRefused(result.failure.code, result.failure.message);
    },
    async selectShape(slideId, shapeId) {
      const context = surface.context();
      if (!context) return;
      await context.navigation.selectShape({ slideId, shapeId }, { expectVersion: await api.version(), focus: true });
    },
    async selectText(range: TextRange) {
      await api.selectText({ slide: await slideNumber(range.slideId), shapeId: range.shapeId, storyId: range.storyId, start: range.start, end: range.end });
    },
    async goToSlide(index) { await api.goToSlide(index + 1); },
    async findText(text): Promise<PptxFindMatch[]> {
      const result = await api.findText({ text, limit: 1000 });
      return result.ok ? result.matches : [];
    },
    async place(kind, slideId, rect: Rect) {
      // TODO(engine): `addShape` / `addTextBox` on the access. Until then a preset is drawn
      // through the editor's own placement tool, exactly as a person would drag it out.
      const a = await access() as PptxAsyncEditorAccess & { addShape?: Function; addTextBox?: Function };
      if ("geometry" in kind && typeof a.addShape === "function") return (await a.addShape(slideId, { name: kind.geometry, geometry: kind.geometry, rect })).shapeId;
      if ("textBox" in kind && typeof a.addTextBox === "function") return (await a.addTextBox(slideId, { name: "TextBox", rect, text: "", style: {} })).shapeId;
      const before = new Set(((await a.snapshot()).slides.find((s) => s.id === slideId)?.shapes ?? []).map((s) => s.id));
      const tool = "textBox" in kind ? "textBox" : `shape:${kind.geometry}`;
      const toolResult = await api.commands.execute("tool", { value: tool as "textBox" });
      if (!toolResult.ok) return null;
      const context = surface.context(), origin = surface.overlayOrigin();
      const box = context?.geometry?.toOverlayRect({ space: "slide-emu", rect });
      if (!box || !origin) { await api.commands.execute("tool", { value: "select" }); return null; }
      const x0 = origin.left + box.x, y0 = origin.top + box.y, x1 = x0 + Math.max(8, box.width), y1 = y0 + Math.max(8, box.height);
      const target = document.elementFromPoint(x0 + 1, y0 + 1);
      if (!target) return null;
      const fire = (type: string, x: number, y: number, buttons: number) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons, clientX: x, clientY: y,
      }));
      fire("pointerdown", x0, y0, 1);
      fire("pointermove", (x0 + x1) / 2, (y0 + y1) / 2, 1);
      fire("pointermove", x1, y1, 1);
      fire("pointerup", x1, y1, 0);
      for (let i = 0; i < 40; i++) {
        await wait(50);
        const shapes = (await a.snapshot()).slides.find((s) => s.id === slideId)?.shapes ?? [];
        const created = shapes.find((s) => !before.has(s.id));
        if (created) return created.id;
      }
      return null;
    },
  };
  return engine;
}
