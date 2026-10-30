import { useTranslation } from "react-i18next";
import type { ListSession, Notice as SessionNotice } from "@finx/client";
import { Icon } from "../icons";
import { useStore } from "../store";

/**
 * A key notice of the session (a warning the kernel marks with a code),
 * popped up above the composer like an approval and in its shape: what holds
 * now, why it matters, and what to do about it. The page words each code it
 * knows; one it does not shows the kernel's message. Got it closes it until
 * the kernel sends it again.
 */
export function Notice({ s, notice, onClose }: { s: ListSession; notice: SessionNotice; onClose: () => void }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const known = notice.code === "bypass_permissions" ? notice.code : null;
  return (
    <div className="knote" role="status" aria-label={t("notice.label")}>
      <div className="knote-h">
        <Icon name="warn" className="knote-i" />
        <b>{known ? t(`notice.${known}.title`) : t("notice.label")}</b>
      </div>
      <p className="knote-b">{known ? t(`notice.${known}.body`) : notice.message}</p>
      <div className="appr-f">
        <span className="appr-sp" />
        {notice.code === "bypass_permissions" && (
          <button className="btn" onClick={() => st.op(s.session_id, { type: "set_permission_mode", mode: "manual" })}>
            {t("notice.bypass_permissions.back")}
          </button>
        )}
        <button className="btn primary" onClick={onClose}>{t("notice.dismiss")}</button>
      </div>
    </div>
  );
}
