import { app, BrowserWindow, dialog, nativeTheme, net, protocol } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { testHome } from "./build";
import { offerToMove } from "./install";
import { docScheme, serveDocs } from "./docs";
import { registerIPC } from "./ipc";
import { retireModelGateway } from "./retire-model-gateway";
import { startKernel } from "./kernel";
import { chooseLanguage } from "./language";
import { setAppMenu } from "./menu";
import { platform } from "./platform";
import { applyAppearance } from "./preferences";
import { startUpdater } from "./updater";
import { devURL, showMain } from "./windows";
import { forgetSitesOnStart } from "./browser/menu";
import { isParking } from "./browser/pages";
import { refreshSystemBrowser } from "./browser/system";

const rendererDir = path.join(import.meta.dirname, "../renderer");
// finxdoc: the documents beside a conversation (main/docs.ts); pdf.js decodes some images with
// WebAssembly and draws pages through blob: URLs.
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' finxdoc:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

// The name people see is FinxWork; the profile stays in the folder it always had (Application Support/finxwork).
app.setName("FinxWork");
// Electron's warnings about a page's security settings are for the app's own pages, which set
// them; in the embedded browser's tabs they would only show in a site's console, where the
// agent reads them as the site's.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
if (process.env.FINXWORK_USER_DATA) app.setPath("userData", process.env.FINXWORK_USER_DATA);
else if (testHome) app.setPath("userData", path.join(testHome, "userData"));
else app.setPath("userData", path.join(app.getPath("appData"), "finxwork"));
chooseLanguage();

protocol.registerSchemesAsPrivileged([
  // codeCache: V8 keeps the renderer's compiled script between launches.
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
  docScheme,
]);

if (!app.requestSingleInstanceLock()) app.quit();

/** The page's files, from inside the app, never outside the renderer's directory. */
function serve() {
  protocol.handle("app", async (req) => {
    const url = new URL(req.url);
    if (url.host !== "finxwork" || devURL) return new Response("not found", { status: 404 });
    const file = path.normalize(path.join(rendererDir, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
    if (!file.startsWith(rendererDir + path.sep)) return new Response("not found", { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    if (file.endsWith(".html")) headers.set("content-security-policy", csp);
    return new Response(res.body, { status: res.status, headers });
  });
}

app.on("second-instance", () => showMain());

/** In development the Dock would show Electron's icon: the brand's, light or dark as the app looks (a built app has its own). */
function devIcon() {
  if (app.isPackaged || !app.dock) return;
  const brand = path.join(app.getAppPath(), "../../assets/brand/macos");
  const show = () => app.dock?.setIcon(path.join(brand, `icon-${nativeTheme.shouldUseDarkColors ? "dark" : "light"}-1024.png`));
  show();
  nativeTheme.on("updated", show);
}

app.whenReady().then(async () => {
  app.setAboutPanelOptions({ applicationName: "FinxWork", applicationVersion: app.getVersion(), version: "", copyright: "" });
  applyAppearance();
  devIcon();
  if (await offerToMove()) return;
  serve();
  serveDocs();
  registerIPC();
  try {
    await retireModelGateway();
  } catch {
    dialog.showErrorBox("模型连接迁移未完成", "旧模型网关暂时无法安全退出。请等待现有任务结束后重新打开 FinxWork；连接配置和登录信息已保留。");
    app.quit();
    return;
  }
  forgetSitesOnStart();
  startKernel();
  void refreshSystemBrowser();
  startUpdater();
  setAppMenu();
  showMain();
  app.on("activate", () => showMain());
});

app.on("window-all-closed", () => {
  if (platform.quitWithLastWindow) app.quit();
});
// The browser's hidden window (browser/pages.ts) is none of the person's, yet it keeps
// window-all-closed from coming: with only it left, their last window has closed.
app.on("browser-window-created", (_e, win) =>
  win.once("closed", () => {
    if (platform.quitWithLastWindow && BrowserWindow.getAllWindows().every((w) => w === win || w.isDestroyed() || isParking(w))) app.quit();
  }),
);
