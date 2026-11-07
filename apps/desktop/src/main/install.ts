import { app, dialog } from "electron";
import { i18n } from "../shared/i18n";
import { isolatedRun } from "./build";
import { preferences, setPreferences } from "./preferences";

// Where the app lives (desktop-release §5). A packaged Mac app outside the
// Applications folder offers to move there before anything starts: Squirrel
// cannot replace an app on a disk image or one macOS translocated (opened
// straight from Downloads), and elsewhere copies pile up. Not moving is fine;
// "don't ask again" is remembered.

/** True when the app is moving: Electron quits and opens the moved copy, so the caller starts nothing. */
export async function offerToMove(): Promise<boolean> {
  if (!app.isPackaged || process.platform !== "darwin" || isolatedRun() || app.isInApplicationsFolder() || preferences().moveDeclined) return false;
  const t = i18n.getFixedT(null, "main", "move");
  const r = await dialog.showMessageBox({
    type: "question",
    message: t("title"),
    detail: t("detail"),
    buttons: [t("move"), t("keep")],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: t("dontAsk"),
  });
  if (r.response !== 0) {
    if (r.checkboxChecked) setPreferences({ moveDeclined: true });
    return false;
  }
  try {
    return app.moveToApplicationsFolder({
      // A copy there that is running would hold the single-instance lock, so this one would not be here.
      conflictHandler: (conflict) =>
        conflict === "existsAndRunning" ||
        dialog.showMessageBoxSync({ type: "question", message: t("replaceTitle"), detail: t("replaceDetail"), buttons: [t("replace"), t("cancel")], defaultId: 0, cancelId: 1 }) === 0,
    });
  } catch (e) {
    dialog.showErrorBox(t("failedTitle"), t("failed", { reason: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}
