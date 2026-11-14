// Arrow keys turn pages like PowerPoint's normal view: on the slide strip, and on the stage
// while no object or text is selected (with one selected, the keys belong to the object).
// NimbleOffice itself only pages with PageUp/PageDown/Home/End, and only on the stage.

const BACK = new Set(["ArrowUp", "ArrowLeft", "PageUp"]);
const FORWARD = new Set(["ArrowDown", "ArrowRight", "PageDown"]);

/** The page a key lands on from `index` of `count`, or null when the key does not page. */
export function slideStep(key: string, index: number, count: number): number | null {
  if (count <= 0 || index < 0) return null;
  const step = BACK.has(key) ? -1 : FORWARD.has(key) ? 1 : 0;
  if (!step) return null;
  return Math.max(0, Math.min(count - 1, index + step));
}

type SlideKeyOptions = {
  /** The active page (0-based) and the page count. */
  position(): { index: number; count: number };
  /** Whether an object or text is selected on the stage. */
  objectSelected(): boolean;
  /** Show page `index` (0-based). */
  go(index: number): Promise<void>;
};

const STRIP_ROW = "aside > button:not([data-testid^='pptx-proposal'])";

export function installSlideKeys(root: HTMLElement, options: SlideKeyOptions): () => void {
  let pending: number | null = null;
  // On document, so the editor's own React handlers (on the surface root, inside `root`) run first.
  const keydown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (!target || !root.contains(target)) return;
    const onStage = target.getAttribute("role") === "application";
    const row = target.closest(STRIP_ROW);
    const onStrip = row instanceof HTMLButtonElement && root.contains(row);
    if (!onStrip && !(onStage && !options.objectSelected())) return;
    const { index, count } = options.position();
    const to = slideStep(e.key, pending ?? index, count);
    if (to === null) return;
    e.preventDefault();
    if (to === (pending ?? index)) return;
    pending = to;
    void options.go(to).finally(() => {
      if (pending === to) pending = null;
      // Keep focus on the strip, now on the page it moved to.
      if (onStrip && root.contains(document.activeElement) && document.activeElement?.closest(STRIP_ROW)) {
        root.querySelector<HTMLButtonElement>(`${STRIP_ROW}[aria-current="page"]`)?.focus({ preventScroll: false });
      }
    });
  };
  document.addEventListener("keydown", keydown);
  return () => document.removeEventListener("keydown", keydown);
}
