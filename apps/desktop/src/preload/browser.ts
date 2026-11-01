import { ipcRenderer } from "electron";
import { maxComment, type AnnotationAnchor, type AnnotationState } from "../shared/annotations";

// Runs in the tab's isolated world, without exposing Electron to visited pages.
// "Add to chat": the person points at a part of the page, says something about it,
// and it goes to the conversation's composer. A closed shadow root keeps website CSS
// out of this UI; all page and comment text is inserted as textContent, never HTML.
if (process.isMainFrame) {
  type Spot = { anchor: AnnotationAnchor; element: Element | null };
  type Draft = Spot & { body: string };
  let state: AnnotationState = { url: "", enabled: false, language: "zh-CN" };
  let host: HTMLDivElement | undefined;
  let root: ShadowRoot;
  let highlight: HTMLDivElement;
  let highlightLabel: HTMLSpanElement;
  let markers: HTMLDivElement;
  let tray: HTMLDivElement;
  let card: HTMLFormElement | null = null;
  let input: HTMLTextAreaElement | null = null;
  let status: HTMLElement | null = null;
  let editing: Spot | null = null;
  let hover: Element | null = null;
  let pending = false, frame = 0;
  let notice: { text: string; error: boolean; timer: number } | null = null;
  /** What was added to the chat from this page, shown as numbered markers while the page lives. */
  let added: (Spot & { body: string })[] = [];
  /** Unsaved text, by element, kept while the page lives. */
  const drafts = new Map<string, Draft>();
  const copy = {
    "zh-CN": { hint: "点击页面上的内容，添加到对话", done: "完成", title: "添加到对话", placeholder: "说说这里要怎么改（可选）", add: "添加到对话", cancel: "收起", failed: "未能添加，请重试。你的文字仍保留在这里。", adding: "添加中…", added: "已添加到对话", shortcut: "↩ 添加 · ⇧↩ 换行 · Esc 收起", readError: "无法使用添加到对话，请重试", draft: "未添加的草稿", sent: "已添加", noMatch: "页面内容已变化" },
    en: { hint: "Click part of the page to add it to the chat", done: "Done", title: "Add to chat", placeholder: "What should change here? (optional)", add: "Add to chat", cancel: "Close", failed: "Could not add. Retry; your text is still here.", adding: "Adding…", added: "Added to the chat", shortcut: "↩ to add · ⇧↩ new line · Esc to close", readError: "Add to chat is unavailable. Please retry.", draft: "Draft not added", sent: "Added", noMatch: "The page has changed" },
  };
  const t = () => state.language === "zh-CN" ? copy["zh-CN"] : copy.en;
  const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  const supported = () => /^https?:/.test(location.href);
  const draftKey = (anchor: AnnotationAnchor) => anchor.selector;
  const short = (s: string, n = 160) => s.length > n ? `${s.slice(0, n)}…` : s;
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", content = ""): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag); el.className = className; el.textContent = content; return el;
  }
  function button(label: string, run: () => void, className = ""): HTMLButtonElement {
    const b = node("button", className, label); b.type = "button"; b.onclick = run; return b;
  }
  // The page's cursor says clicks now pick. An adopted sheet leaves the page's DOM untouched.
  let cursor: CSSStyleSheet | undefined;
  function setCursor(on: boolean) {
    try {
      if (!cursor) { cursor = new CSSStyleSheet(); document.adoptedStyleSheets = [...document.adoptedStyleSheets, cursor]; }
      cursor.replaceSync(on ? "*,*::before,*::after{cursor:crosshair!important}" : "");
    } catch { /* The page replaced its sheets: only the cursor is lost. */ }
  }
  function ensure() {
    if (host) return;
    host = node("div"); host.setAttribute("data-finx-annotations", "");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;color-scheme:light dark!important";
    root = host.attachShadow({ mode: "closed" });
    const style = node("style"); style.textContent = `
      :host{--bg:#fff;--fg:#20242c;--muted:#707782;--line:#e5e8ed;--wash:#f5f7fa;--blue:#2388f5;--blue-dark:#0967cb;--red:#d35c59;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--fg)}
      @media(prefers-color-scheme:dark){:host{--bg:#25272d;--fg:#f1f3f7;--muted:#a3a9b5;--line:#424650;--wash:#30333a;--red:#f07b78}}
      *{box-sizing:border-box}button,textarea{font:inherit}button{cursor:pointer;color:inherit;border:0;background:transparent;border-radius:8px;padding:7px 10px}button:hover{background:var(--wash)}button:focus-visible,textarea:focus-visible{outline:2px solid var(--blue);outline-offset:2px}button:disabled{opacity:.45;cursor:default}button:disabled:hover{background:transparent}
      .highlight{position:fixed;border:2px solid var(--blue);background:#2388f512;border-radius:5px;pointer-events:none;display:none}
      .highlight span{position:absolute;left:-2px;bottom:100%;margin-bottom:4px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--blue);color:#fff;font:600 11px/18px ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 6px;border-radius:4px}
      .highlight.low span{bottom:auto;top:100%;margin:4px 0 0}
      .pin,.draft-pin{position:fixed;pointer-events:auto;width:26px;height:26px;border-radius:13px 13px 13px 3px;border:2px solid #fff;background:var(--blue);color:#fff;font-size:11px;font-weight:650;padding:0;box-shadow:0 2px 8px #0003;transform:translate(-5px,-21px);transition:scale .1s}
      .pin{cursor:default}.pin:hover{background:var(--blue)}
      .draft-pin{background:var(--bg);color:var(--blue);border:2px dashed var(--blue);font-size:14px;line-height:1}.draft-pin:hover,.draft-pin.active{background:var(--blue-dark);color:#fff;scale:1.12}
      .tray{position:fixed;right:16px;bottom:16px;max-width:calc(100vw - 32px);pointer-events:auto;background:var(--bg);border:1px solid var(--line);border-radius:12px;box-shadow:0 6px 28px #0002;overflow:hidden}
      .bar{display:flex;gap:4px;align-items:center;padding:4px 4px 4px 12px}.hint{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.hint.ok{color:var(--blue);font-weight:600}.hint.error{color:var(--red)}.done{font-weight:600;white-space:nowrap}
      .card{position:fixed;width:320px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;pointer-events:auto;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:16px;padding:14px;box-shadow:0 12px 44px #0003;animation:appear .12s ease-out}
      .head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600}.close{padding:2px 8px;font-size:16px;line-height:1.2;color:var(--muted)}
      .quote{border-left:2px solid var(--blue);padding-left:9px;margin:8px 0;color:var(--muted);font-size:12px;max-height:42px;overflow:hidden;overflow-wrap:anywhere}.quote.lost{border-color:var(--red)}
      textarea{display:block;resize:none;min-height:72px;max-height:40vh;width:100%;border:0;border-radius:8px;padding:9px;background:var(--wash);color:var(--fg);margin:10px 0;line-height:1.6}textarea:focus{outline:2px solid #2388f560;outline-offset:0}
      .footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.add{background:var(--blue);color:#fff;font-weight:600;padding:7px 14px}.add:hover{background:var(--blue-dark)}.add:disabled:hover{background:var(--blue)}
      .status{font-size:11px;color:var(--muted);min-width:0}.error{color:var(--red)}.over{color:#d98a12}
      @keyframes appear{from{opacity:0;translate:0 3px}to{opacity:1;translate:0 0}}@media(prefers-reduced-motion:reduce){.card{animation:none}.pin,.draft-pin{transition:none}}
    `;
    highlight = node("div", "highlight"); highlightLabel = node("span"); highlight.append(highlightLabel);
    markers = node("div"); tray = node("div", "tray");
    // Keys typed in the editor stay out of the page's shortcuts (e.g. "/" to search).
    for (const name of ["keydown", "keyup", "keypress"] as const) root.addEventListener(name, (e) => e.stopPropagation());
    root.append(style, highlight, markers, tray); document.documentElement.append(host);
  }
  function selector(el: Element): string {
    const parts: string[] = [];
    for (let current: Element | null = el; current && current !== document.documentElement; current = current.parentElement) {
      if (current.id && document.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1) { parts.unshift(`#${CSS.escape(current.id)}`); break; }
      const siblings: Element[] = Array.from(current.parentElement?.children ?? []).filter((s) => s.localName === current!.localName);
      parts.unshift(`${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})`);
    }
    return parts.join(" > ") || "html";
  }
  function describe(el: Element) {
    const id = el.id ? `#${el.id}` : "";
    const cls = !id && typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join("") : "";
    return el.localName + id + cls;
  }
  function point(el: Element, a: AnnotationAnchor) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * a.x, y: r.top + r.height * a.y, visible: r.width > 0 && r.height > 0 };
  }
  function place(pin: HTMLElement, spot: Spot | undefined) {
    const p = spot?.element?.isConnected ? point(spot.element, spot.anchor) : null;
    pin.hidden = !p || !p.visible || p.x < 0 || p.x > innerWidth || p.y < 0 || p.y > innerHeight;
    if (p) { pin.style.left = `${p.x}px`; pin.style.top = `${p.y}px`; }
  }
  function positionCard() {
    if (!card || !editing) return;
    const w = card.offsetWidth, h = card.offsetHeight;
    const p = editing.element?.isConnected ? point(editing.element, editing.anchor) : { x: innerWidth / 2 - w / 2 - 20, y: innerHeight / 3 };
    // Beside the spot, on whichever side has room, so the card never covers what it is about.
    let x = p.x + 20;
    if (x + w > innerWidth - 12 && p.x - w - 20 >= 12) x = p.x - w - 20;
    let y = p.y - 12;
    if (y + h > innerHeight - 12) y = innerHeight - h - 12;
    x = Math.max(12, Math.min(innerWidth - w - 12, x)); y = Math.max(12, y);
    card.style.left = `${x}px`; card.style.top = `${y}px`;
  }
  function refresh() {
    frame = 0;
    if (!host || !state.enabled) return;
    const r = hover?.isConnected ? hover.getBoundingClientRect() : null;
    highlight.style.display = r ? "block" : "none";
    if (r) {
      Object.assign(highlight.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      highlight.classList.toggle("low", r.top < 26);
    }
    for (const pin of Array.from(markers.children) as HTMLButtonElement[]) {
      if (pin.dataset.draft) {
        place(pin, drafts.get(pin.dataset.draft));
        pin.classList.toggle("active", !!editing && draftKey(editing.anchor) === pin.dataset.draft);
      } else place(pin, added[Number(pin.dataset.index)]);
    }
    positionCard();
  }
  function schedule() { if (state.enabled && !frame) frame = requestAnimationFrame(refresh); }
  function showNotice(text: string, error = false) {
    if (notice) clearTimeout(notice.timer);
    notice = { text, error, timer: window.setTimeout(() => { notice = null; render(); }, error ? 4000 : 2000) };
    render();
  }
  /** Keep what was typed: an unsent draft shows as a dashed marker the person can come back to. */
  function stash() {
    if (!editing || !input) return;
    if (input.value.trim()) drafts.set(draftKey(editing.anchor), { ...editing, body: input.value });
    else drafts.delete(draftKey(editing.anchor));
  }
  function dropCard() { card?.remove(); card = null; input = null; editing = null; status = null; }
  function closeEditor() {
    if (pending) return;
    stash(); dropCard(); render();
  }
  function openEditor(anchor: AnnotationAnchor, element: Element | null) {
    if (pending) return;
    if (card) { stash(); dropCard(); }
    editing = { anchor, element };
    card = node("form", "card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-label", t().title);
    const close = button("×", closeEditor, "close"); close.setAttribute("aria-label", t().cancel); close.title = t().cancel;
    const head = node("div", "head"); head.append(node("span", "", t().title), close);
    const quote = node("div", element ? "quote" : "quote lost", element ? anchor.text || `<${anchor.tag}>` : t().noMatch);
    input = node("textarea"); input.placeholder = t().placeholder; input.setAttribute("aria-label", t().title); input.maxLength = maxComment;
    input.value = drafts.get(draftKey(anchor))?.body ?? "";
    const footer = node("div", "footer");
    status = node("span", "status", t().shortcut); status.setAttribute("role", "status");
    const add = node("button", "add", t().add); add.type = "submit";
    footer.append(status, add);
    const sync = () => {
      const n = input!.value.length;
      // The textarea grows with the text, up to its maximum height.
      input!.style.height = "auto"; input!.style.height = `${input!.scrollHeight}px`;
      if (status && !pending && !status.classList.contains("error")) {
        status.textContent = n > maxComment * .8 ? `${n.toLocaleString()} / ${maxComment.toLocaleString()}` : t().shortcut;
        status.className = n >= maxComment ? "status over" : "status";
      }
      positionCard();
    };
    input.oninput = () => { status?.classList.remove("error"); sync(); };
    input.onkeydown = (event) => {
      if (event.isComposing || event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault(); void submit();
    };
    card.append(head, quote, input, footer); card.onsubmit = (e) => { e.preventDefault(); void submit(); };
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const controls = Array.from(card!.querySelectorAll<HTMLElement>("button:not(:disabled),textarea:not(:disabled)"));
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && root.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && root.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
    root.append(card); sync(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    render();
  }
  async function submit() {
    if (!editing || !input || pending) return;
    pending = true;
    const spot = editing, body = input.value;
    card?.querySelectorAll("button").forEach((b) => b.disabled = true);
    input.disabled = true; if (status) { status.textContent = t().adding; status.className = "status"; }
    try {
      await ipcRenderer.invoke("browser-annotation", { action: "chat", url: state.url, anchor: spot.anchor, body });
      pending = false; dropCard(); drafts.delete(draftKey(spot.anchor));
      added.push({ ...spot, body: body.trim() });
      showNotice(t().added);
    } catch {
      pending = false;
      card?.querySelectorAll("button").forEach((b) => b.disabled = false);
      if (input) { input.disabled = false; input.focus(); }
      if (status) { status.textContent = t().failed; status.className = "status error"; }
    }
  }
  function render() {
    ensure(); host!.style.setProperty("display", state.enabled ? "block" : "none", "important");
    setCursor(state.enabled);
    if (!state.enabled) return;
    markers.replaceChildren();
    added.forEach((a, i) => {
      const pin = node("button", "pin", String(i + 1)); pin.type = "button"; pin.tabIndex = -1; pin.dataset.index = String(i);
      pin.title = a.body ? `${t().sent} · ${short(a.body)}` : t().sent; pin.setAttribute("aria-label", pin.title); markers.append(pin);
    });
    for (const [key, d] of drafts) {
      const pin = button("✎", () => openEditor(d.anchor, d.element?.isConnected ? d.element : null), "draft-pin");
      pin.dataset.draft = key; pin.setAttribute("aria-label", `${t().draft}: ${short(d.body)}`); pin.title = `${t().draft}\n${short(d.body)}`;
      markers.append(pin);
    }
    tray.replaceChildren();
    const bar = node("div", "bar");
    const hint = node("span", notice ? (notice.error ? "hint error" : "hint ok") : "hint", notice?.text ?? t().hint);
    hint.setAttribute("role", "status");
    bar.append(hint, button(t().done, exit, "done")); tray.append(bar);
    schedule();
  }
  function accept(next: AnnotationState) {
    if (next.url !== location.href) return;
    if (state.url !== next.url) {
      pending = false; dropCard(); drafts.clear(); added = []; if (notice) clearTimeout(notice.timer); notice = null;
    }
    state = next; if (!state.enabled) { hover = null; closeEditor(); } render();
  }
  function exit() {
    if (pending) return;
    closeEditor();
    void ipcRenderer.invoke("browser-annotation", { action: "exit", url: state.url }).then(accept).catch(() => showNotice(t().readError, true));
  }
  const ownEvent = (e: Event) => !!host && e.composedPath().includes(host);
  // On the window, in the capture phase, before anything the page registers: the preload runs first.
  window.addEventListener("pointermove", (e) => {
    if (!state.enabled) return;
    const next = ownEvent(e) || !(e.target instanceof Element) ? null : e.target;
    if (next === hover) return;
    hover = next; if (hover) highlightLabel.textContent = describe(hover);
    schedule();
  }, true);
  // Leaving the window clears the outline rather than leaving it on the last element.
  window.addEventListener("mouseout", (e) => { if (!e.relatedTarget && hover) { hover = null; schedule(); } }, true);
  for (const name of ["pointerdown", "mousedown", "mouseup", "pointerup", "click", "dblclick", "auxclick"] as const) {
    window.addEventListener(name, (e: MouseEvent) => {
      if (!state.enabled || ownEvent(e) || e.button !== 0) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (name !== "click" || pending) return;
      const el = e.target instanceof Element ? e.target : null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const anchor = { selector: selector(el), text: text(el), tag: el.localName,
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1))), y: Math.max(0, Math.min(1, (e.clientY - r.top) / (r.height || 1))) };
      // Coming back to an element with an unsent draft reopens that draft where it was left.
      openEditor(drafts.get(draftKey(anchor))?.anchor ?? anchor, el);
    }, true);
  }
  window.addEventListener("keydown", (e) => {
    if (!state.enabled || e.isComposing || e.key !== "Escape") return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (card) closeEditor(); else exit();
  }, true);
  window.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
  ipcRenderer.on("browser-annotation-state", (_event, next: AnnotationState) => accept(next));
  window.addEventListener("DOMContentLoaded", () => {
    const observer = new MutationObserver((mutations) => {
      if (state.enabled && mutations.some((m) => m.target !== host && !host?.contains(m.target))) schedule();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"], characterData: true });
    new ResizeObserver(schedule).observe(document.documentElement);
    if (supported()) void ipcRenderer.invoke("browser-annotation", { action: "read", url: location.href }).then(accept).catch(() => {});
  }, { once: true });
}
