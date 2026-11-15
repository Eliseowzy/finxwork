import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GroupFile, GroupSummary } from "@finx/protocol";
import { Dialog } from "../components";
import { useBrowserTabs, BrowserPanel } from "../session/Browser";
import { PdfView } from "../docs/PdfView";
import type { DocTab } from "../docs/state";
import { useStore } from "../store";

/**
 * A group message's file, beside the group: a PDF in pdf.js, an HTML file in the in-app browser,
 * exactly as a bot conversation shows its own files. External files are opened by path under the
 * group's folder, never with the system's default app (bot-contacts-design §8, DD-185).
 */
export function GroupFilePreview({ group, file, onClose }: { group: GroupSummary; file: GroupFile; onClose: () => void }) {
  const { t } = useTranslation("groups");
  const st = useStore();
  const session = `group:${group.id}`;
  const path = group.files_dir ? `${group.files_dir}/${file.path.replace(/^files\//, "")}` : null;
  const html = /\.html?$/i.test(file.name) || file.media_type === "text/html";
  const pdf = /\.pdf$/i.test(file.name) || file.media_type === "application/pdf";
  const [doc, setDoc] = useState<DocTab | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabs = useBrowserTabs().filter((tab) => tab.session === session);
  useEffect(() => {
    let live = true;
    setDoc(null);
    setError(null);
    if (!path) {
      setError(t("preview.missing"));
      return;
    }
    if (html) {
      void window.finx?.openPageFile(session, path).then((ok) => {
        if (live && !ok) setError(t("preview.failed"));
      }).catch(() => live && setError(t("preview.failed")));
    } else if (pdf) {
      void st.call("doc/open", { session_id: session, path }).then((r) => {
        if (live) setDoc({ info: r.info, token: r.token, page: 1, password: r.password ?? undefined });
      }).catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    } else {
      setError(t("preview.unsupported"));
    }
    return () => {
      live = false;
    };
  }, [path, html, pdf, session, st, t]);
  return (
    <Dialog label={file.name} width={920} className="gfilepreview" onClose={onClose}>
      <div className="gfilepreview-head">
        <span className="gfilepreview-name">{file.name}</span>
        <button className="tb" aria-label={t("panel.close")} title={t("panel.close")} onClick={onClose}>
          ×
        </button>
      </div>
      {error ? (
        <p className="sub gfilepreview-error">{error}</p>
      ) : html ? (
        tabs.length > 0 ? (
          <div className="gfilepreview-body">
            <BrowserPanel session={session} tabs={tabs} max onMax={() => {}} onClose={onClose} />
          </div>
        ) : (
          <p className="sub">{t("preview.loading")}</p>
        )
      ) : doc && st.rpc ? (
        <div className="gfilepreview-body">
          <PdfView rpc={st.rpc} session={session} tab={doc} jump={null} />
        </div>
      ) : (
        <p className="sub">{t("preview.loading")}</p>
      )}
    </Dialog>
  );
}
