// A `deck_edit` the agent made, as the conversation shows it (presentation-deck-edit §6): the
// tool's details, the pages it changed, and where the editor should go to show them. Kept free
// of React so it is tested alone.

/** How one page changed. */
export type DeckSlideStatus = "changed" | "inserted" | "deleted" | "moved" | "unchanged";

/** `deck_edit`'s result details, when it changed the deck. */
export type DeckEditDetails = {
  deck_id: string;
  path: string;
  /** The change's id for `deck/undo`: the revision it made. */
  edit: number;
  note: string | null;
  /** `index` is 0-based. */
  slides: { index: number; slide_id: string; status: DeckSlideStatus }[];
};

const statuses = new Set<string>(["changed", "inserted", "deleted", "moved", "unchanged"]);

/** The details of a `deck_edit` result that changed the deck, or null. */
export function deckEditDetails(raw: unknown): DeckEditDetails | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.deck_id !== "string" || typeof d.path !== "string" || typeof d.edit !== "number" || !Array.isArray(d.slides)) return null;
  const slides = d.slides.flatMap((s) => {
    if (!s || typeof s !== "object") return [];
    const x = s as Record<string, unknown>;
    if (typeof x.index !== "number") return [];
    const status = typeof x.status === "string" && statuses.has(x.status) ? (x.status as DeckSlideStatus) : "changed";
    return [{ index: x.index, slide_id: String(x.slide_id ?? ""), status }];
  });
  return { deck_id: d.deck_id, path: d.path, edit: d.edit, note: typeof d.note === "string" ? d.note : null, slides };
}

/** The pages a change touched, in order; unchanged pages are left out. */
export const changedSlides = (d: DeckEditDetails) => d.slides.filter((s) => s.status !== "unchanged").sort((a, b) => a.index - b.index);

/** The page to show for a change: the first one still in the deck. */
export const firstShown = (d: DeckEditDetails): number | null => changedSlides(d).find((s) => s.status !== "deleted")?.index ?? changedSlides(d)[0]?.index ?? null;

// ── going to a page ──
// A step's click opens the deck and asks for a page; an editor not yet up takes it when ready.

const wanted = new Map<string, number>();
const GOTO = "finx:deck-goto";

/** Asks the editor of the kernel's deck `deckId` to show page `index` (0-based), now or once it is ready. */
export function requestSlide(deckId: string, index: number) {
  wanted.set(deckId, index);
  window.dispatchEvent(new CustomEvent(GOTO, { detail: { deckId } }));
}

/** The page asked for `deckId`, once. */
export function takeSlide(deckId: string): number | null {
  const at = wanted.get(deckId);
  wanted.delete(deckId);
  return at ?? null;
}

/** Calls `go` whenever a page of `deckId` is asked for. */
export function onSlideRequest(deckId: string, go: (index: number) => void): () => void {
  const listen = (e: Event) => {
    if ((e as CustomEvent<{ deckId: string }>).detail?.deckId !== deckId) return;
    const at = takeSlide(deckId);
    if (at !== null) go(at);
  };
  window.addEventListener(GOTO, listen);
  return () => window.removeEventListener(GOTO, listen);
}
