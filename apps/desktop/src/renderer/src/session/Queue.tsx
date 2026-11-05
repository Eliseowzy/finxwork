import { useTranslation } from "react-i18next";
import { userText } from "@finx/client";
import type { QueuedInput } from "@finx/protocol";
import { Icon } from "../icons";

/**
 * What was sent while the task runs and it has not taken in yet, in the
 * order it takes them in: interjections at its next step, queued messages
 * once it would finish. A tray that comes out from behind the composer, as
 * wide as it: each row's icon and words line up with the composer's "+" and
 * text. On hover a row's time gives way to what can be done with it: a
 * queued message can interject instead, an interjection can go in now (the
 * step under way ends), and either can be edited (it comes back to the
 * composer) or deleted. Its buttons keep the focus in the composer. Its last
 * row says which sent message the composer now holds, while one is being
 * written again: the row finds it in the conversation, × goes back to the draft.
 */
export function Queue({ items, approving, onNow, onInterject, onEdit, onDelete, again }: {
  items: QueuedInput[];
  /** An approval waits: it is answered first, so nothing goes in now. */
  approving: boolean;
  onNow: () => void;
  onInterject: (q: QueuedInput) => void;
  /** None while a sent message is being written again: the composer is taken. */
  onEdit?: (q: QueuedInput) => void;
  onDelete: (q: QueuedInput) => void;
  again?: { label: string; why: string; onFind: () => void; onCancel: () => void };
}) {
  const { t } = useTranslation("session");
  const keep = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="cq" role="list" aria-label={t("queued.label")}>
      {items.map((q) => {
        const { text, files, comments } = userText(q.message.content);
        const more = q.message.content.filter((c) => c.type === "image").length + files.length + comments.length;
        const steer = q.mode === "steer";
        return (
          <div key={q.id} className="cq-row" role="listitem" data-mode={q.mode}>
            <span className="cq-i" title={t(`composer.${q.mode}Mode`)}>
              <Icon name={steer ? "steer" : "clock"} />
            </span>
            <span className="cq-t">{text.split("\n")[0] || t("queued.attachments", { count: more })}</span>
            {text && more > 0 && <span className="cq-n">{t("queued.more", { count: more })}</span>}
            <span className="cq-when">{t(steer ? "queued.next" : "queued.after")}</span>
            <span className="cq-acts">
              {steer ? (
                <button className={`cq-b ${approving ? "off" : ""}`} aria-disabled={approving} title={t(approving ? "queued.nowApproval" : "queued.nowTip")} onMouseDown={keep} onClick={() => !approving && onNow()}>
                  {t("queued.now")}
                </button>
              ) : (
                <button className="cq-b" title={t("queued.interjectTip")} onMouseDown={keep} onClick={() => onInterject(q)}>
                  {t("queued.interject")}
                </button>
              )}
              {onEdit && (
                <button className="cq-ib" title={t("queued.edit")} aria-label={t("queued.edit")} onMouseDown={keep} onClick={() => onEdit(q)}>
                  <Icon name="edit" />
                </button>
              )}
              <button className="cq-ib" title={t("queued.delete")} aria-label={t("queued.delete")} onMouseDown={keep} onClick={() => onDelete(q)}>
                <Icon name="x" />
              </button>
            </span>
          </div>
        );
      })}
      {again && (
        <div className="cq-again" role="listitem">
          <div className="cq-row">
            <span className="cq-i">
              <Icon name="edit" />
            </span>
            <button className="cq-t cq-find" title={t("resend.find")} onMouseDown={keep} onClick={again.onFind}>
              {t("resend.from", { text: again.label })}
            </button>
            <button className="cq-ib cq-x" title={t("resend.cancel")} aria-label={t("resend.cancel")} onMouseDown={keep} onClick={again.onCancel}>
              <Icon name="x" />
            </button>
          </div>
          <p className="cq-why">{again.why}</p>
        </div>
      )}
    </div>
  );
}
