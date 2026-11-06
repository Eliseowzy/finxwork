import { useTranslation } from "react-i18next";
import { baseName } from "@finx/client";
import { Icon } from "../icons";
import { openRef } from "../session/contentMenus";
import { useStore } from "../store";

/** Waiting for a file. */
export function FileLoading() {
  const { t } = useTranslation("session");
  return (
    <div className="fpn-empty">
      <span className="mini-spin" aria-label={t("files.loading")} />
    </div>
  );
}

/** Why a file is not shown, and where else it opens: nowhere, when it is gone. */
export function FileCard({ path, rel, text, gone }: { path: string; rel: string | null; text: string; gone?: boolean }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const mac = window.finx?.platform === "mac";
  return (
    <div className="fpn-card">
      <Icon name="file" />
      <b>{baseName(path)}</b>
      {/* The name is above; an error that starts with the path need not say it again. */}
      <p>{text.startsWith(`${path}: `) ? text.slice(path.length + 2) : text}</p>
      {!gone && (
        <div className="fpn-card-b">
          <button className="btn" onClick={() => void openRef(st, { path, rel, kind: "file" }, undefined, "system")}>{t("files.openDefault")}</button>
          <button className="btn" onClick={() => window.finx?.revealPath(path)}>{t(mac ? "content.revealFinder" : "content.reveal")}</button>
        </div>
      )}
    </div>
  );
}
