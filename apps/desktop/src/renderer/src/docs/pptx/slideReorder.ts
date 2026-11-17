/** Translate an insertion boundary into the engine's index after removing the source. */
export function slideInsertionIndex(source: number, boundary: number): number {
  return boundary > source ? boundary - 1 : boundary;
}

type ReorderOptions = {
  move(sourceId: string, toIndex: number): Promise<void>;
  onError(error: unknown): void;
};

/** Host-owned insertion feedback and drop handling for NimbleOffice's slide strip. */
export function installSlideReorder(root: HTMLElement, options: ReorderOptions): () => void {
  const indicator = document.createElement("div");
  indicator.className = "pptx-drop-indicator";
  indicator.hidden = true;
  indicator.setAttribute("aria-hidden", "true");
  root.append(indicator);
  let source: HTMLButtonElement | null = null;
  let strip: HTMLElement | null = null;
  let pointerY = 0;
  let scrollFrame = 0;
  let ghostFrame = 0;
  let destination: number | null = null;

  const rows = () => strip ? Array.from(strip.children).filter((el): el is HTMLButtonElement => el instanceof HTMLButtonElement) : [];
  const rowAt = (target: EventTarget | null) => {
    const row = target instanceof Element ? target.closest("aside > button") : null;
    return row instanceof HTMLButtonElement && root.contains(row) ? row : null;
  };
  function hide() {
    indicator.hidden = true;
    destination = null;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  }
  function reset() {
    hide();
    cancelAnimationFrame(ghostFrame);
    source?.classList.remove("pptx-slide-dragging");
    source = null;
    strip = null;
  }
  function update() {
    if (!source || !strip) return hide();
    const list = rows(), sourceIndex = list.indexOf(source);
    if (sourceIndex < 0 || !list.length) return hide();
    let boundary = list.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return pointerY < rect.top + rect.height / 2;
    });
    if (boundary < 0) boundary = list.length;
    const toIndex = slideInsertionIndex(sourceIndex, boundary);
    const before = list[boundary - 1]?.getBoundingClientRect();
    const after = list[boundary]?.getBoundingClientRect();
    const y = before && after ? (before.bottom + after.top) / 2 : after ? after.top - 6 : before!.bottom + 6;
    const bounds = strip.getBoundingClientRect(), host = root.getBoundingClientRect();
    // First/last boundaries sit in the strip's outer padding. Interior boundaries
    // should disappear when their gap has scrolled out of the viewport.
    const top = boundary === 0 && strip.scrollTop === 0 ? bounds.top - 8 : bounds.top;
    const bottom = boundary === list.length && strip.scrollTop + strip.clientHeight >= strip.scrollHeight - 1 ? bounds.bottom + 8 : bounds.bottom;
    if (y < top || y > bottom) { indicator.hidden = true; destination = null; return; }
    indicator.style.left = `${bounds.left - host.left + 6}px`;
    indicator.style.top = `${y - host.top}px`;
    indicator.style.width = `${Math.max(0, bounds.width - 12)}px`;
    indicator.hidden = false;
    destination = toIndex === sourceIndex ? null : toIndex;
  }
  function scroll() {
    scrollFrame = 0;
    if (!strip || !source) return;
    const bounds = strip.getBoundingClientRect();
    const zone = 30;
    const delta = pointerY < bounds.top + zone ? -Math.min(10, (bounds.top + zone - pointerY) / 3)
      : pointerY > bounds.bottom - zone ? Math.min(10, (pointerY - bounds.bottom + zone) / 3) : 0;
    if (!delta) return;
    const before = strip.scrollTop;
    strip.scrollTop += delta;
    update();
    if (strip.scrollTop !== before) scrollFrame = requestAnimationFrame(scroll);
  }
  const start = (event: DragEvent) => {
    const row = rowAt(event.target);
    if (!row?.draggable || row.disabled || !event.dataTransfer) return;
    reset();
    source = row;
    strip = row.parentElement;
    event.dataTransfer.effectAllowed = "move";
    // Let the browser capture the full-opacity drag image first.
    ghostFrame = requestAnimationFrame(() => source?.classList.add("pptx-slide-dragging"));
  };
  const over = (event: DragEvent) => {
    if (!source || !strip || !(event.target instanceof Node) || !strip.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    pointerY = event.clientY;
    update();
    if (event.dataTransfer) event.dataTransfer.dropEffect = indicator.hidden ? "none" : "move";
    if (!scrollFrame) scrollFrame = requestAnimationFrame(scroll);
  };
  const drop = (event: DragEvent) => {
    if (!source || !strip || !(event.target instanceof Node) || !strip.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    pointerY = event.clientY;
    update();
    const id = event.dataTransfer?.getData("text/plain"), index = destination;
    reset();
    if (id && index !== null) void options.move(id, index).catch(options.onError);
  };
  const leave = (event: DragEvent) => {
    if (!strip || event.relatedTarget instanceof Node && strip.contains(event.relatedTarget)) return;
    const rect = strip.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) hide();
  };
  const outsideDrop = (event: DragEvent) => { if (!(event.target instanceof Node) || !root.contains(event.target)) reset(); };
  root.addEventListener("dragstart", start, true);
  root.addEventListener("dragover", over, true);
  root.addEventListener("drop", drop, true);
  root.addEventListener("dragleave", leave, true);
  document.addEventListener("dragend", reset, true);
  document.addEventListener("drop", outsideDrop, true);
  return () => {
    reset();
    indicator.remove();
    root.removeEventListener("dragstart", start, true);
    root.removeEventListener("dragover", over, true);
    root.removeEventListener("drop", drop, true);
    root.removeEventListener("dragleave", leave, true);
    document.removeEventListener("dragend", reset, true);
    document.removeEventListener("drop", outsideDrop, true);
  };
}
