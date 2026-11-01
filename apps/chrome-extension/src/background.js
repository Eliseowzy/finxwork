import { ExtensionBrowser } from "./browser.js";
import { bridge } from "./methods.js";

// The FinxWork extension (browser-design §8.4): a Native Messaging port to `finx browser
// native-host`, which relays to the finx service, and an ExtensionBrowser for each browser
// the kernel starts on it. A new stream number is a new browser; the one before is let go.
// The open port keeps this worker alive; an alarm brings it back if Chrome stopped it.
//
// The store updates this extension apart from FinxWork, so the hello says which bridge
// versions it speaks (D-219): `bridge` from methods.js, down to BRIDGE_MIN, the oldest whose
// frames and commands it still handles. Keep BRIDGE_MIN low: a FinxWork app updates later
// than its extension. A kept-alive worker never takes an update by itself; it reloads for
// one while the agent has no tab here.

const HOST = "com.finxwork.browser";
const PROTOCOL = "1.3";
const BRIDGE_MIN = 1;
const GROUP_TITLE = "FinxWork";

/** @type {chrome.runtime.Port | null} */
let port = null;
/** @type {{ stream: number, browser: ExtensionBrowser } | null} */
let live = null;
/** Pieces of a message over Chrome's 1 MB limit, by stream. */
const pieces = new Map();

// ---- The tabs of the agent ----

/** The window the agent's tabs open in: its own, so the user's tabs are never taken. */
let windowId = null;
/** Tab group by finx session. */
const groups = new Map();

async function agentWindow() {
  if (windowId !== null) {
    try {
      await chrome.windows.get(windowId);
      return windowId;
    } catch {
      windowId = null;
    }
  }
  return null;
}

async function group(tabId, label) {
  const key = label ?? "";
  const known = groups.get(key);
  try {
    if (known !== undefined) {
      await chrome.tabs.group({ groupId: known, tabIds: [tabId] });
      return;
    }
  } catch {
    groups.delete(key);
  }
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    groups.set(key, groupId);
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "blue" });
  } catch {
    // Tab groups are a nicety; a tab outside one works the same.
  }
}

/** @type {import("./browser.js").Tabs} */
const tabs = {
  async create(url, label) {
    let tab;
    const existing = await agentWindow();
    if (existing === null) {
      const win = await chrome.windows.create({ url, focused: false, type: "normal" });
      windowId = win.id;
      tab = win.tabs[0];
    } else {
      tab = await chrome.tabs.create({ windowId: existing, url, active: true });
    }
    await group(tab.id, label);
    return tab.id;
  },
  adopt(tabId, label) {
    void group(tabId, label);
  },
  close(tabId) {
    chrome.tabs.remove(tabId).catch(() => {});
  },
  activate(tabId) {
    chrome.tabs.update(tabId, { active: true }).catch(() => {});
  },
  async attach(tabId) {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  },
  detach(tabId) {
    chrome.debugger.detach({ tabId }).catch(() => {});
  },
  send(tabId, child, method, params) {
    const target = child ? { tabId, sessionId: child } : { tabId };
    return chrome.debugger.sendCommand(target, method, params);
  },
};

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== undefined) live?.browser.event(source.tabId, source.sessionId, method, params ?? {});
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== undefined) live?.browser.detached(source.tabId, reason);
});
chrome.tabs.onCreated.addListener((tab) => live?.browser.tabCreated(tab.id, tab.openerTabId, tab.pendingUrl ?? tab.url));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url !== undefined || change.title !== undefined) live?.browser.tabUpdated(tabId, change);
});
chrome.tabs.onRemoved.addListener((tabId) => live?.browser.tabRemoved(tabId));
chrome.windows.onRemoved.addListener((id) => {
  if (id === windowId) windowId = null;
});

// ---- The host ----

function show(state, detail) {
  const title = { connected: "FinxWork: connected", waiting: `FinxWork: ${detail ?? "waiting"}`, missing: `FinxWork: ${detail}` }[state];
  chrome.action.setTitle({ title }).catch(() => {});
  chrome.action.setBadgeText({ text: state === "connected" ? "" : "!" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: state === "missing" ? "#d93025" : "#9aa0a6" }).catch(() => {});
}

function letGo() {
  live?.browser.close();
  live = null;
  pieces.clear();
}

// ---- Updates ----

/** Set when the store has a newer version waiting for this worker to restart. */
let updateWaiting = false;

/** Restarts into the waiting update, unless the agent is using a tab here. */
function takeUpdate() {
  if (updateWaiting && !(live && live.browser.byTab.size > 0)) chrome.runtime.reload();
}

chrome.runtime.onUpdateAvailable.addListener(() => {
  updateWaiting = true;
  takeUpdate();
});

function onMessage(message) {
  if (typeof message.status === "string") {
    // The service came or went: a browser of the connection before is gone, and the new
    // connection numbers its streams from the start again.
    letGo();
    if (message.status === "outdated") {
      show("missing", message.reason);
      // Too old for this FinxWork: ask the store now rather than within hours.
      if (message.update === "extension") chrome.runtime.requestUpdateCheck?.().catch(() => {});
    } else {
      show(message.status === "connected" ? "connected" : "waiting", message.reason);
    }
    takeUpdate();
    return;
  }
  const stream = message.stream;
  if (typeof stream !== "number") return;
  // Streams count up while the host stays connected (a reconnect says so first, which lets
  // the browser go): a late message of a browser that has ended is dropped.
  if (live && stream < live.stream) return;
  let data = message.data;
  if (typeof message.part === "string") {
    const soFar = (pieces.get(stream) ?? "") + message.part;
    if (message.more) {
      pieces.set(stream, soFar);
      return;
    }
    pieces.delete(stream);
    // Pieces are of the message's JSON text.
    try {
      data = JSON.parse(soFar);
    } catch {
      return;
    }
  }
  if (typeof data !== "object" || data === null) return;
  if (live?.stream !== stream) {
    letGo();
    const out = (message) => port?.postMessage({ stream, data: message });
    live = { stream, browser: new ExtensionBrowser(tabs, out) };
  }
  live.browser.receive(data);
}

/** Tells the host which browser this is, so FinxWork can show it. */
async function hello() {
  let browser = navigator.userAgent;
  try {
    // Brands name Edge, Brave and Chrome apart; the generic ones ("Chromium", "Not A;Brand") last.
    const data = await navigator.userAgentData.getHighEntropyValues(["fullVersionList"]);
    const brands = (data.fullVersionList ?? []).filter((b) => !/Not.?A.?Brand/i.test(b.brand));
    const named = brands.find((b) => b.brand !== "Chromium") ?? brands[0];
    if (named) browser = `${named.brand} ${named.version}`;
  } catch {
    // The user agent string says enough.
  }
  port?.postMessage({
    hello: { browser, extension_version: chrome.runtime.getManifest().version, bridge: { min: BRIDGE_MIN, max: bridge } },
  });
}

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    show("missing", String(e));
    return;
  }
  port.onMessage.addListener(onMessage);
  void hello();
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    port = null;
    letGo();
    show("missing", error?.includes("not found") ? "run `finx browser extension install`, then reload this extension" : (error ?? "the host stopped"));
  });
  show("waiting", "looking for FinxWork");
}

chrome.alarms.create("finx-connect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "finx-connect") {
    connect();
    takeUpdate();
  }
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.action.onClicked.addListener(connect);
connect();
