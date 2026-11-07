import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RpcClient } from "@finx/client";
import { useOpenFile } from "../composer/Tile";
import { firstShown, requestSlide, type DeckEditDetails } from "../docs/pptx/deckEdit";

/**
 * What the agent changed in a deck, under its step (presentation-deck-edit §6): the page to look
 * at, opened beside the conversation, and 撤销, which takes the change back in the deck. Only
 * the agent's latest change can be taken back; the kernel says so when it is not.
 */
export function DeckEditActions({ details, rpc, session }: { details: DeckEditDetails; rpc: RpcClient; session: string }) {
  const { t } = useTranslation("session");
  const openFile = useOpenFile();
  const [state, setState] = useState<"idle" | "busy" | "undone">("idle");
  const [error, setError] = useState<string | null>(null);
  const page = firstShown(details);
  const show = () => {
    if (page !== null) requestSlide(details.deck_id, page);
    openFile(details.path);
  };
  const undo = () => {
    if (state !== "idle") return;
    setState("busy");
    setError(null);
    rpc.request("deck/undo", { session_id: session, deck_id: details.deck_id, edit: details.edit }).then(
      () => setState("undone"),
      (e: unknown) => { setState("idle"); setError(e instanceof Error ? e.message : String(e)); },
    );
  };
  return (
    <div className="deck-edit" data-testid="deck-edit">
      <button className="deck-edit-go" onClick={show}>{page !== null ? t("deckEdit.show", { n: page + 1 }) : t("deckEdit.open")}</button>
      {state === "undone" ? (
        <span className="deck-edit-done">{t("deckEdit.undone")}</span>
      ) : (
        <button className="deck-edit-undo" disabled={state === "busy"} onClick={undo}>{t("deckEdit.undo")}</button>
      )}
      {error && <span className="deck-edit-err" role="alert">{t("deckEdit.failed", { message: error })}</span>}
    </div>
  );
}
