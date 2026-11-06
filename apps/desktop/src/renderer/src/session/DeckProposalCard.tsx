import { useCallback, useEffect, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { RpcClient } from "@finx/client";
import { cardReducer, changedSlides, deckCall, initialCard, type DeckEditDetails } from "../docs/pptx/deckProposal";

// The pending card that answers ⌘↩: the latest one mounted.
const pending: (() => void)[] = [];

/** A `deck_edit` proposal in the conversation: the pages it changes, accept or reject (presentation-deck-edit §6). */
export function DeckProposalCard({ details, rpc, session }: { details: DeckEditDetails; rpc: RpcClient; session: string }) {
  const { t } = useTranslation("session");
  const [state, dispatch] = useReducer(cardReducer(details.proposal_id), initialCard);
  const { deck_id, proposal_id } = details;
  const name = details.path.split(/[\\/]/).pop() || details.path;
  const slides = changedSlides(details);

  const refresh = useCallback(() => {
    deckCall(rpc, "deck/proposals", { session_id: session, deck_id }).then((r) => dispatch({ type: "listed", proposals: r.proposals ?? [] }), () => {});
  }, [rpc, session, deck_id]);
  useEffect(() => {
    refresh();
    return rpc.on("deck/changed", (n) => { if (n.deck_id === deck_id) refresh(); });
  }, [rpc, deck_id, refresh]);

  const fail = (e: unknown) => dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
  const accept = () => {
    if (state.status !== "pending" || state.busy) return;
    dispatch({ type: "start", action: "accept" });
    deckCall(rpc, "deck/proposal/accept", { session_id: session, deck_id, proposal_id, ...(state.stale ? { force: true } : {}) })
      .then((r) => dispatch({ type: "accepted", applied: r.acceptance?.applied !== false }), fail);
  };
  const reject = () => {
    if (state.status !== "pending" || state.busy) return;
    dispatch({ type: "start", action: "reject" });
    deckCall(rpc, "deck/proposal/reject", { session_id: session, deck_id, proposal_id }).then((r) => dispatch({ type: "rejected", rejected: r.rejected }), fail);
  };
  const acceptRef = useRef(accept);
  acceptRef.current = accept;

  const open = state.status === "pending";
  useEffect(() => {
    if (!open) return;
    const go = () => acceptRef.current();
    pending.push(go);
    const onKey = (e: KeyboardEvent) => {
      if (pending.at(-1) !== go || !(e.metaKey || e.ctrlKey) || e.key !== "Enter" || e.defaultPrevented) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "") || (document.activeElement as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      go();
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); pending.splice(pending.indexOf(go), 1); };
  }, [open]);

  return (
    <div className="appr deck-proposal" role="region" aria-label={t("deckProposal.label")} data-testid="deck-proposal-card">
      <div className="appr-h">
        <b>{t("deckProposal.title", { name, count: slides.length })}</b>
      </div>
      <ul className="deck-proposal-slides">
        {slides.map((s) => <li key={`${s.index}-${s.slide_id}`}>{t("deckProposal.slide", { n: s.index + 1, status: t(`deckProposal.status.${s.status}`) })}</li>)}
      </ul>
      {state.stale && open && <div className="deck-proposal-note">{t("deckProposal.stale")}</div>}
      {state.error && <div className="deck-proposal-note err" role="alert">{t("deckProposal.failed", { message: state.error })}</div>}
      <div className="appr-f">
        {open ? (
          <>
            <span className="appr-sp" />
            <button className="btn" disabled={!!state.busy} onClick={reject}>{t("deckProposal.reject")}</button>
            <button className="btn primary" disabled={!!state.busy} onClick={accept}>
              {state.stale ? t("deckProposal.force") : t("deckProposal.accept")}
              <span className="kret">⌘↩</span>
            </button>
          </>
        ) : (
          <span className="deck-proposal-done" data-status={state.status}>{t(`deckProposal.done.${state.status}`)}</span>
        )}
      </div>
    </div>
  );
}
