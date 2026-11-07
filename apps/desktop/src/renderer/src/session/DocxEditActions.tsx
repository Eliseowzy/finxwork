import { useReducer } from "react";
import { useTranslation } from "react-i18next";
import type { RpcClient } from "@finx/client";
import { useOpenFile } from "../composer/Tile";
import { reviewRevisions, showWordChange, undoEdit } from "../docs/docx/ai";
import { stepRow, stepRowStart, type DocxEditDetails } from "../docs/docx/aiPrompt";

/**
 * What the agent changed in a Word document, under its step (word-design §5.1 item 5), as
 * DeckEditActions for a deck: the change to look at, opened beside the conversation; 撤销; and
 * for revisions, accepting or rejecting all of this step's at once (not under a docx_review step,
 * which is itself an acceptance or a rejection).
 */
export function DocxEditActions({ details, rpc, session, review: reviewable = true }: { details: DocxEditDetails; rpc: RpcClient; session: string; review?: boolean }) {
  const { t } = useTranslation("session");
  const openFile = useOpenFile();
  const [s, dispatch] = useReducer(stepRow, stepRowStart);
  const fail = (e: unknown) => dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
  const show = () => {
    showWordChange(details.path, { revision: details.revisions[0], paragraph: details.paragraphs[0] });
    openFile(details.path);
  };
  const undo = () => {
    if (s.undo !== "idle" || s.review === "busy") return;
    dispatch({ type: "undo" });
    undoEdit(rpc, session, details.docx_id, details.edit).then(() => dispatch({ type: "undone" }), fail);
  };
  const review = (action: "accept" | "reject") => {
    if (s.review !== "idle" || s.undo !== "idle") return;
    dispatch({ type: "review", action });
    reviewRevisions(rpc, session, details.docx_id, action, details.revisions).then(() => dispatch({ type: "reviewed", action }), fail);
  };
  const settled = s.review === "accepted" || s.review === "rejected";
  const busy = s.undo === "busy" || s.review === "busy";
  return (
    <div className="deck-edit" data-testid="docx-edit">
      <button className="deck-edit-go" onClick={show}>{t("docxEdit.show")}</button>
      {s.undo === "undone" ? (
        <span className="deck-edit-done">{t("deckEdit.undone")}</span>
      ) : settled ? (
        <span className="deck-edit-done">{t(s.review === "accepted" ? "docxEdit.accepted" : "docxEdit.rejected")}</span>
      ) : (
        <>
          <button className="deck-edit-undo" disabled={busy} onClick={undo}>{t("deckEdit.undo")}</button>
          {reviewable && details.mode === "suggest" && details.revisions.length > 0 && (
            <>
              <button disabled={busy} onClick={() => review("accept")}>{t("docxEdit.acceptAll")}</button>
              <button disabled={busy} onClick={() => review("reject")}>{t("docxEdit.rejectAll")}</button>
            </>
          )}
        </>
      )}
      {s.error && <span className="deck-edit-err" role="alert">{t("docxEdit.failed", { message: s.error })}</span>}
    </div>
  );
}
