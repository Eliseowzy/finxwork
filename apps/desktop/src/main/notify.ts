import fs from "node:fs";
import { Notification } from "electron";
import { mainWindow, showMain } from "./windows";

// A system notification when a session needs the person and the app is not in front: they may be
// looking at their browser, where the agent works. A click opens that session.
//
// End-to-end tests (FINXWORK_E2E_NOTIFIED=<file>): what would show is written there, one JSON per
// line: a system notification cannot be read back.

const recordTo = process.env.FINXWORK_E2E_NOTIFIED;
/** Kept until clicked or closed: a notification collected early loses its click. */
const showing = new Set<Notification>();

export function notify(n: unknown) {
  const { title, body, session } = (n ?? {}) as { title?: unknown; body?: unknown; session?: unknown };
  if (typeof title !== "string" || typeof body !== "string" || typeof session !== "string") return;
  if (recordTo) return fs.appendFileSync(recordTo, `${JSON.stringify({ title, body, session })}\n`);
  if (!Notification.isSupported()) return;
  const note = new Notification({ title, body });
  showing.add(note);
  note.on("close", () => showing.delete(note));
  note.on("click", () => {
    showing.delete(note);
    showMain();
    mainWindow()?.webContents.send("open-session", session);
  });
  note.show();
}
