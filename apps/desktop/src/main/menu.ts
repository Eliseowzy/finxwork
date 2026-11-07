import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from "electron";
import type { Command } from "../shared/bridge";
import { i18n } from "../shared/i18n";
import { command, currentMenuState, menuStateListeners } from "./ipc";
import { platform } from "./platform";
import { install, openUpdates, updateInfo, updateListeners } from "./updater";
import { mainWindow, settingsVisible, showMain, showSettings } from "./windows";

// The app menu. Its items are the page's commands (renderer/src/commands.ts);
// what they enable and check follows what the page reports (MenuState).
//
// Windows and Linux: the same menu, for its shortcuts, but the window's menu
// bar stays hidden (Alt shows it), since the page has every action.

export function setAppMenu() {
  build();
  menuStateListeners.add(build);
  updateListeners.add(build);
  app.on("browser-window-created", (_e, w) => {
    if (!platform.appMenu) w.setAutoHideMenuBar(true);
    // The window menu checks the open windows.
    const rebuild = () => setImmediate(build);
    w.on("show", rebuild);
    w.on("hide", rebuild);
    w.on("closed", rebuild);
    rebuild();
  });
}

function build() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
}

function template(): MenuItemConstructorOptions[] {
  const t = i18n.getFixedT(null, "main", "menu");
  const st = currentMenuState();
  const s = st.session;
  const sep = { type: "separator" } as const;
  // Checkbox items flip themselves when clicked: rebuilt, they show the page's state again.
  const item = (id: Command, label: string, enabled: boolean, more: MenuItemConstructorOptions = {}): MenuItemConstructorOptions => ({
    id,
    label,
    enabled,
    click: () => {
      command(id);
      setImmediate(build);
    },
    ...more,
  });
  const settings: MenuItemConstructorOptions = { id: "settings", label: t("settings"), accelerator: "CmdOrCtrl+,", click: () => showSettings() };
  // A downloaded update offers the restart; otherwise the check, which the settings' About page shows.
  const u = updateInfo().update;
  const updates: MenuItemConstructorOptions =
    u.state === "ready"
      ? { id: "installUpdate", label: t("app.restartToUpdate", { version: u.version }), click: install }
      : { id: "checkUpdates", label: t("app.checkUpdates"), enabled: u.state !== "unsupported", click: openUpdates };

  return [
    ...(platform.appMenu
      ? [
          {
            label: "FinxWork",
            submenu: [
              { id: "about", label: t("app.about"), click: () => app.showAboutPanel() },
              updates,
              sep,
              settings,
              sep,
              { role: "services", label: t("app.services") },
              sep,
              { role: "hide", label: t("app.hide") },
              { role: "hideOthers", label: t("app.hideOthers") },
              { role: "unhide", label: t("app.unhide") },
              sep,
              { role: "quit", label: t("app.quit") },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: t("file.title"),
      submenu: [
        item("newSession", t("file.newSession"), true, { accelerator: "CmdOrCtrl+N" }),
        item("openProject", t("file.openProject"), true, { accelerator: "Shift+CmdOrCtrl+O" }),
        sep,
        item("attachFiles", t("file.attachFiles"), st.main, { accelerator: "CmdOrCtrl+U" }),
        item("attachFolder", t("file.attachFolder"), st.main),
        sep,
        ...(platform.appMenu ? [] : [settings, sep]),
        { role: "close", label: t("file.close") },
      ],
    },
    {
      label: t("edit.title"),
      submenu: [
        {
          id: "undo",
          label: t("edit.undo"),
          accelerator: "CmdOrCtrl+Z",
          // What the main window's toast offers to undo (an archive), unless typing there; otherwise the text field's own undo.
          click: () => {
            const w = BrowserWindow.getFocusedWindow();
            if (currentMenuState().undo && (!w || w === mainWindow())) command("undo");
            else w?.webContents.undo();
          },
        },
        { role: "redo", label: t("edit.redo") },
        sep,
        { role: "cut", label: t("edit.cut") },
        { role: "copy", label: t("edit.copy") },
        { role: "paste", label: t("edit.paste") },
        { role: "selectAll", label: t("edit.selectAll") },
        sep,
        item("search", t("edit.find"), true, { accelerator: "CmdOrCtrl+F" }),
        // ⌘K, as the sidebar's Search shows; the menu lists ⌘F.
        { label: t("edit.search"), accelerator: "CmdOrCtrl+K", visible: false, click: () => command("search") },
      ],
    },
    {
      label: t("view.title"),
      submenu: [
        item("nextAttention", t("view.nextAttention"), st.main, { accelerator: "CmdOrCtrl+2" }),
        item("nextActive", t("view.nextActive"), st.main, { accelerator: "CmdOrCtrl+3" }),
        sep,
        item("toggleInspector", s?.inspector === false ? t("view.showInspector") : t("view.hideInspector"), !!s, { accelerator: "Alt+CmdOrCtrl+0" }),
        item("toggleSidebar", st.sidebar ? t("view.hideSidebar") : t("view.showSidebar"), st.main, { accelerator: platform.appMenu ? "Ctrl+Cmd+S" : "Ctrl+Shift+S" }),
        sep,
        { role: "togglefullscreen", label: t("view.fullScreen") },
      ],
    },
    {
      label: t("session.title"),
      submenu: [
        item("approve", t("session.approve"), !!s?.approvable || st.botApprovable, { accelerator: "CmdOrCtrl+Enter" }),
        item("interrupt", t("session.interrupt"), !!s?.interruptible, { accelerator: "CmdOrCtrl+." }),
        sep,
        item("rename", t("session.rename"), !!s),
        item("archive", t("session.archive"), !!s?.archivable, { accelerator: "CmdOrCtrl+E" }),
        item("unarchive", t("session.unarchive"), !!s?.archived),
        sep,
        item("copySessionId", t("session.copyId"), !!s),
        item("revealSessionFile", platform.id === "mac" ? t("session.revealFinder") : t("session.reveal"), !!s),
      ],
    },
    {
      label: t("window.title"),
      submenu: [
        { role: "minimize", label: t("window.minimize") },
        { role: "zoom", label: t("window.zoom") },
        sep,
        { id: "mainWindow", label: "FinxWork", type: "checkbox", checked: !!mainWindow()?.isVisible(), click: () => (showMain(), setImmediate(build)) },
        { id: "settingsWindow", label: t("window.settings"), type: "checkbox", checked: settingsVisible(), click: () => (showSettings(), setImmediate(build)) },
      ],
    },
    {
      role: "help",
      label: t("help.title"),
      submenu: [{ id: "shortcuts", label: t("help.shortcuts"), click: showShortcuts }],
    },
  ];
}

/** The shortcuts, as the menus list them. */
function showShortcuts() {
  const lines: string[] = [];
  for (const m of template()) {
    if (!Array.isArray(m.submenu)) continue;
    for (const i of m.submenu) if (i.accelerator && i.label && i.visible !== false) lines.push(`${keys(String(i.accelerator))}\t${i.label}`);
  }
  dialog.showMessageBox({ message: i18n.t("main:menu.help.shortcuts"), detail: lines.join("\n") });
}

/** "Shift+CmdOrCtrl+N" → "⇧⌘N", in the order macOS shows modifiers. */
function keys(accelerator: string): string {
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  const symbols: [string, string][] = [["Ctrl", "⌃"], ["Alt", "⌥"], ["Shift", "⇧"], ["Cmd", "⌘"], ["CmdOrCtrl", "⌘"]];
  const named: Record<string, string> = { Enter: "↩" };
  return symbols.filter(([m]) => parts.includes(m)).map(([, sym]) => sym).join("") + (named[key] ?? key);
}
