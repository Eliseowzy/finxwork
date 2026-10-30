import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { baseName, homePath, type ListSession, type SessionView } from "@finx/client";
import { Icon } from "../icons";
import { MenuButton, MenuItem } from "../composer/Composer";
import { useStore } from "../store";
import { ContextCard } from "./Context";

/**
 * Cards floating over the conversation's top right, one under the other:
 * where the session works, then what fills its context. The environment:
 * the computer, the project's folder and the git branch, a line each, the
 * folder and the branch buttons to what one does with them. Laid out as the
 * sidebar is: a group's heading, then rows. Shown or hidden with the
 * toolbar's button (⌥⌘0).
 */
export function Inspector({ s, view }: { s: ListSession; view: SessionView }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const cwd = view.info.cwd;
  // Read again as each task starts and ends (it may have switched branches), and when the window comes back to the front.
  const tasks = view.entries.filter((e) => e.type === "task_end").length + (view.live ? 1 : 0);
  const branch = useBranch(cwd, tasks);
  const mac = window.finx?.platform === "mac";
  const copyPath = () => navigator.clipboard.writeText(cwd).then(() => st.show(t("inspector.copiedPath")));
  const copyBranch = () => branch && navigator.clipboard.writeText(branch).then(() => st.show(t("inspector.copiedBranch", { branch })));
  return (
    <div className="insp-stack" role="complementary" aria-label={t("inspector.label")}>
      <section className="insp">
        <h3>{t("inspector.environment")}</h3>
        <ul>
          <li>
            <span className="insp-row">
              <Icon name="laptop" />
              <span className="insp-t">{t("inspector.local")}</span>
            </span>
          </li>
          {/* The project's name first; its folder's path gives way when long. */}
          <li>
            <MenuButton
              className="insp-row"
              title={cwd}
              below
              label={
                <>
                  <Icon name="folder" />
                  <span className="insp-where">
                    <span className="insp-t">{baseName(cwd)}</span>
                    <span className="insp-sub"> · {homePath(parentDir(cwd), window.finx?.home ?? "")}</span>
                  </span>
                </>
              }
            >
              {(close) => (
                <>
                  <MenuItem icon="folder" label={mac ? t("inspector.openFinder") : t("inspector.openFolder")} onClick={() => (close(), window.finx?.openFolder(cwd))} />
                  <MenuItem icon="terminal" label={t("inspector.openTerminal")} onClick={() => (close(), window.finx?.openTerminal(cwd))} />
                  <div className="msep" role="separator" />
                  <MenuItem icon="copy" label={t("inspector.copyPath")} onClick={() => (close(), void copyPath())} />
                </>
              )}
            </MenuButton>
          </li>
          {/* Always a line, so the card keeps its shape: the branch, or that the folder is no git repository. */}
          <li>
            {branch ? (
              <button className="insp-row" title={t("inspector.copyBranch")} onClick={copyBranch}>
                <Icon name="branch" />
                <span className="insp-t">{branch}</span>
              </button>
            ) : (
              <span className="insp-row">
                <Icon name="branch" />
                <span className="insp-sub">{branch === null ? t("inspector.noGit") : ""}</span>
              </span>
            )}
          </li>
        </ul>
      </section>
      <ContextCard id={s.session_id} view={view} />
    </div>
  );
}

/** The git branch checked out in `cwd`, read again whenever `tick` changes or the window gains focus; null outside a repository, undefined until read. */
function useBranch(cwd: string, tick: number): string | null | undefined {
  const [branch, setBranch] = useState<string | null>();
  useEffect(() => {
    let current = true;
    const read = () => void window.finx?.gitBranch(cwd).then((b) => current && setBranch(b));
    read();
    window.addEventListener("focus", read);
    return () => {
      current = false;
      window.removeEventListener("focus", read);
    };
  }, [cwd, tick]);
  return branch;
}

/** The folder a project sits in: "/Users/me/CodeSpace/finxwork" → "/Users/me/CodeSpace". */
function parentDir(path: string): string {
  const i = path.replace(/[\\/]+$/, "").search(/[\\/][^\\/]*$/);
  return i > 0 ? path.slice(0, i) : path;
}
