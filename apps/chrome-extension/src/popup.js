// The extension's page, from its toolbar icon (browser-design §8.4.7): how the connection stands
// and what to do about it, the sessions with tabs here and the way back to their conversations,
// and handing the tab in front to the agent. The worker holds the state.

const msg = (name, ...args) => chrome.i18n.getMessage(name, args.map(String)) || name;
const root = document.getElementById("root");

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const act = (action) => chrome.runtime.sendMessage(action).then(draw);
const closing = (action) => () => chrome.runtime.sendMessage(action).then(() => window.close());
const button = (label, onclick, className = "") => el("button", { className, onclick, textContent: label });

function status(state) {
  const [dot, text] = {
    connected: state.inUse ? ["on", msg("statusConnected")] : ["", msg("statusStandby")],
    connecting: ["", msg("statusConnecting")],
    not_open: ["", msg("statusNotOpen")],
    missing: ["", msg("statusMissing")],
    outdated: ["warn", msg("statusOutdated")],
  }[state.host];
  return el("span", { className: "status" }, el("i", { className: `dot ${dot}` }), text);
}

function sessionLine(s) {
  if (s.handoff) return msg("handoff", s.handoff);
  const tabs = s.tabs === 1 ? msg("oneTab") : msg("tabs", s.tabs);
  if (s.state === "awaiting_approval") return msg("approval");
  return `${tabs} · ${s.state === "running" ? msg("working") : msg("finished")}`;
}

function session(s) {
  const acts = el("div", { className: "acts" });
  if (s.state === "running" && !s.handoff) acts.append(button(msg("stop"), () => act({ do: "stop", session: s.id }), "danger"));
  acts.append(button(msg("back"), closing({ do: "back", session: s.id })));
  if (s.handoff) acts.append(button(msg("done"), () => act({ do: "done", session: s.id }), "primary"));
  return el("div", { className: "session" }, el("div", {}, el("b", { textContent: s.title }), el("span", { textContent: sessionLine(s) })), acts);
}

async function draw() {
  const state = await chrome.runtime.sendMessage({ get: "state" });
  const parts = [el("div", { className: "head" }, el("img", { src: chrome.runtime.getURL("icons/32.png"), alt: "" }), "FinxWork", status(state))];
  if (state.host === "not_open") {
    parts.push(el("p", { className: "hint", textContent: msg("hintNotOpen") }));
    parts.push(el("div", { className: "acts start" }, button(msg("openApp"), closing({ do: "open_app" }), "primary")));
  } else if (state.host === "missing") {
    parts.push(el("p", { className: "hint", textContent: msg("hintMissing") }));
  } else if (state.host === "outdated") {
    parts.push(el("p", { className: "hint", textContent: msg("hintOutdated") }));
  } else if (state.host === "connected" && !state.inUse) {
    parts.push(el("p", { className: "hint", textContent: msg("hintStandby") }));
    parts.push(el("div", { className: "acts start" }, button(msg("useThis"), () => act({ do: "use_this" }))));
  }
  for (const s of state.sessions) parts.push(session(s));
  if (state.host === "connected" && state.inUse && state.sessions.length === 0) parts.push(el("p", { className: "hint", textContent: msg("nothing") }));
  if (state.host === "connected" && state.inUse && state.offerable) {
    parts.push(el("div", { className: "offer" }, button(msg("offer"), closing({ do: "offer" })), el("p", { className: "hint", textContent: msg("offerNote") })));
  }
  root.replaceChildren(...parts);
}

void draw();
