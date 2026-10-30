import { useTranslation } from "react-i18next";
import type { Notice as SessionNotice } from "@finx/client";
import { Icon } from "../icons";

/**
 * A key notice of the session (a warning the kernel marks with a code),
 * popped up above the composer like an approval and in its shape: the
 * kernel's message and Got it, which closes it until the kernel sends it
 * again.
 */
export function Notice({ notice, onClose }: { notice: SessionNotice; onClose: () => void }) {
  const { t } = useTranslation("session");
  return (
    <div className="knote" role="status" aria-label={t("notice.label")}>
      <div className="knote-h">
        <Icon name="warn" className="knote-i" />
        <b>{t("notice.label")}</b>
      </div>
      <p className="knote-b">{notice.message}</p>
      <div className="appr-f">
        <span className="appr-sp" />
        <button className="btn primary" onClick={onClose}>{t("notice.dismiss")}</button>
      </div>
    </div>
  );
}
