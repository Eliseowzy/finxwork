// A `deck_edit` proposal as the conversation shows it (presentation-deck-edit §6): what the
// tool's details say, the server methods the card calls, and the card's state as answers and
// `deck/changed` refetches arrive. Kept free of React so the state logic is tested alone.
//
// The details' shape is the tool's, declared here in one place; the methods' are the protocol's.
import type { DeckProposalEntry } from "@finx/protocol";

/** How one page changed (the engine's proposal strip). */
export type DeckSlideStatus = "changed" | "inserted" | "deleted" | "moved" | "unchanged";

/** `deck_edit`'s result details. */
export type DeckEditDetails = {
  deck_id: string;
  path: string;
  proposal_id: string;
  revision: number;
  /** `index` is 0-based. */
  slides: { index: number; slide_id: string; status: DeckSlideStatus }[];
};

/** What the card reads of a `deck/proposals` entry (`DeckProposalEntry`). */
export type ListedProposal = Pick<DeckProposalEntry, "id" | "status">;

const statuses = new Set<string>(["changed", "inserted", "deleted", "moved", "unchanged"]);

/** The details of a `deck_edit` result, or null when they are not (yet) that shape. */
export function deckEditDetails(raw: unknown): DeckEditDetails | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.deck_id !== "string" || typeof d.proposal_id !== "string" || typeof d.path !== "string" || !Array.isArray(d.slides)) return null;
  const slides = d.slides.flatMap((s) => {
    if (!s || typeof s !== "object") return [];
    const x = s as Record<string, unknown>;
    if (typeof x.index !== "number") return [];
    const status = typeof x.status === "string" && statuses.has(x.status) ? (x.status as DeckSlideStatus) : "changed";
    return [{ index: x.index, slide_id: String(x.slide_id ?? ""), status }];
  });
  return { deck_id: d.deck_id, path: d.path, proposal_id: d.proposal_id, revision: typeof d.revision === "number" ? d.revision : 0, slides };
}

/** The pages a proposal touches, in order; unchanged pages are left out. */
export const changedSlides = (d: DeckEditDetails) => d.slides.filter((s) => s.status !== "unchanged").sort((a, b) => a.index - b.index);

/**
 * pending: waiting for the user. accepted / rejected: decided, here or in the editor.
 * handled: no longer listed (the kernel keeps the latest 64 decided), which way not known.
 */
export type ProposalStatus = "pending" | "accepted" | "rejected" | "handled";
export type CardState = {
  status: ProposalStatus;
  busy: "accept" | "reject" | null;
  /** The pages changed under it: accepting needs force. */
  stale: boolean;
  error: string | null;
};

export type CardEvent =
  | { type: "start"; action: "accept" | "reject" }
  | { type: "accepted"; applied: boolean }
  | { type: "rejected"; rejected: boolean }
  | { type: "failed"; message: string }
  | { type: "listed"; proposals: ListedProposal[] };

export const initialCard: CardState = { status: "pending", busy: null, stale: false, error: null };
const decided = (s: ProposalStatus) => s === "accepted" || s === "rejected";

export function cardReducer(id: string) {
  return (state: CardState, event: CardEvent): CardState => {
    switch (event.type) {
      case "start":
        return state.status === "pending" && !state.busy ? { ...state, busy: event.action, error: null } : state;
      case "accepted":
        // Not applied: its targets changed meanwhile; it stays pending and a second accept forces it.
        return event.applied ? { ...state, status: "accepted", busy: null, stale: false } : { ...state, busy: null, stale: true };
      case "rejected":
        // false: it was no longer pending (the editor got there first).
        return { ...state, status: event.rejected ? "rejected" : decided(state.status) ? state.status : "handled", busy: null };
      case "failed":
        return { ...state, busy: null, error: event.message };
      case "listed": {
        // What this card decided itself stands; a refetch only learns of decisions made elsewhere.
        if (decided(state.status)) return state;
        const found = event.proposals.find((p) => p.id === id);
        if (!found || found.status !== "pending") return { ...state, status: found?.status ?? "handled", busy: null };
        return state.status === "pending" ? state : { ...state, status: "pending" };
      }
    }
  };
}
