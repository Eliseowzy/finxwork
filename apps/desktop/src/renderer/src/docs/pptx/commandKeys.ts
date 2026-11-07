// Keyboard shortcuts for the ribbon's commands. Every command's chord lives on its registry entry
// (`shortcut`, also shown in its tooltip); this turns a keydown into the first enabled command that
// owns the chord. The editor's own handlers (undo, text formatting and clipboard while typing) run
// first and mark the event handled, so a chord is never applied twice.

export type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

const CODE_KEYS: Record<string, string> = {
  Period: ".", Comma: ",", Equal: "=", Minus: "-", Slash: "/", Space: "Space",
  BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Backquote: "`", Backslash: "\\",
};

/** The physical key, so ⇧⌘. stays "." and ⌥⌘F stays "f" whatever the layout's shifted glyph. */
function keyName(e: KeyLike): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  return CODE_KEYS[e.code] ?? (e.key.length === 1 ? e.key.toLowerCase() : e.key);
}

/** Whether `e` is exactly `shortcut` ("Mod+Shift+C"; Mod is ⌘ on macOS, Ctrl elsewhere). */
export function matches(e: KeyLike, shortcut: string, mac: boolean): boolean {
  const parts = shortcut.split("+"), key = parts.pop()!;
  const want = new Set(parts);
  const mod = mac ? e.metaKey : e.ctrlKey;
  const ctrl = mac ? e.ctrlKey : false;
  if (mod !== want.has("Mod") || e.shiftKey !== want.has("Shift") || e.altKey !== want.has("Alt") || ctrl !== want.has("Ctrl")) return false;
  if (!mac && e.metaKey) return false;
  return keyName(e).toLowerCase() === key.toLowerCase();
}

/** Where the key was pressed: the slide strip, the stage (nothing or an object selected), or inside text. */
export type KeyPlace = "strip" | "stage" | "text";

// Chords that mean something else on the slide strip, as in PowerPoint.
const STRIP: { shortcut: string; id: string }[] = [
  { shortcut: "Mod+D", id: "duplicateSlide" },
  { shortcut: "Delete", id: "deleteSlide" },
  { shortcut: "Backspace", id: "deleteSlide" },
];

// While typing, select-all, duplicate and the like belong to the text, not the slide's objects.
const NOT_IN_TEXT = new Set(["selectAll", "duplicate", "cut", "copy", "paste", "group", "ungroup", "slideshow"]);

export type ShortcutCommand = { id: string; shortcut?: string };

/** The ids `e` could run at `place`, in the order to try them. */
export function candidates(e: KeyLike, place: KeyPlace, commands: readonly ShortcutCommand[], mac: boolean): string[] {
  const out: string[] = [];
  if (place === "strip") for (const s of STRIP) if (matches(e, s.shortcut, mac)) out.push(s.id);
  for (const c of commands) {
    if (!c.shortcut || !matches(e, c.shortcut, mac)) continue;
    if (place === "text" && NOT_IN_TEXT.has(c.id)) continue;
    out.push(c.id);
  }
  return out;
}

type CommandKeyOptions = {
  commands: () => readonly ShortcutCommand[];
  /** Whether text is being edited (the caret is in a text box). */
  editingText(): boolean;
  enabled(id: string): boolean;
  run(id: string): void;
  /** ⌘S anywhere in the editor. */
  save(): void;
  /** ⌘A while typing: select the whole text of the box being edited. */
  selectAllText(): void;
};

const STRIP_ROW = "aside > button:not([data-testid^='pptx-proposal'])";

export function installCommandKeys(root: HTMLElement, options: CommandKeyOptions): () => void {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const keydown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (!target || !root.contains(target)) return;
    const text = options.editingText();
    // A ribbon field (font size, find box) keeps its keys; the editor's own text input does not.
    if (!text && target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (matches(e, "Mod+S", mac)) { e.preventDefault(); options.save(); return; }
    const row = target.closest(STRIP_ROW);
    if (text && matches(e, "Mod+A", mac)) { e.preventDefault(); options.selectAllText(); return; }
    const place: KeyPlace = row instanceof HTMLButtonElement && root.contains(row) ? "strip" : text ? "text" : "stage";
    for (const id of candidates(e, place, options.commands(), mac)) {
      if (!options.enabled(id)) continue;
      e.preventDefault();
      if (!e.repeat || id !== "deleteSlide") options.run(id);
      return;
    }
  };
  document.addEventListener("keydown", keydown);
  return () => document.removeEventListener("keydown", keydown);
}
