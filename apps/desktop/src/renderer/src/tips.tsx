import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** How long the pointer rests on a button before its tip shows, and how soon after one tip goes the next shows at once. */
const REST = 350;
const CARRY = 600;

/** A shortcut at the end of a tip ("会话信息 ⌥⌘0") is shown apart from its words. */
const SHORTCUT = /\s([⌃⌥⇧⌘]+\S+)$/;

type Tip = { text: string; keys?: string; x: number; top: number; bottom: number };

/**
 * Toolbar buttons' tips (desktop-design §5.4). The system's tip waits over a second and cannot be
 * hurried, so the buttons' `title` is shown here instead: after a short rest, and at once when the
 * pointer moves on along a row of buttons. While a button is pointed at, its title sits in
 * `data-tip`, which keeps the system's own tip away.
 */
export function Tips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let el: HTMLElement | null = null;
    let timer = 0;
    let shown = false;
    let gone = 0;
    let watch: MutationObserver | null = null;

    const take = (b: HTMLElement) => {
      const title = b.getAttribute("title");
      if (title !== null) {
        b.dataset.tip = title;
        b.removeAttribute("title");
      }
    };
    const show = () => {
      if (!el?.isConnected || !el.dataset.tip) return;
      const r = el.getBoundingClientRect();
      const m = SHORTCUT.exec(el.dataset.tip);
      setTip({ text: m ? el.dataset.tip.slice(0, m.index) : el.dataset.tip, keys: m?.[1], x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
      shown = true;
    };
    const hide = () => {
      clearTimeout(timer);
      watch?.disconnect();
      watch = null;
      if (el) {
        // The title goes back, so anything reading it finds it there.
        if (el.dataset.tip !== undefined && !el.hasAttribute("title")) el.setAttribute("title", el.dataset.tip);
        delete el.dataset.tip;
      }
      if (shown) gone = Date.now();
      el = null;
      shown = false;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      const b = (e.target as Element | null)?.closest?.<HTMLElement>(".tb") ?? null;
      if (b === el) return;
      const carry = shown || Date.now() - gone < CARRY;
      hide();
      if (!b) return;
      take(b);
      if (!b.dataset.tip) return;
      el = b;
      // A button that changes its title while pointed at (say, on a click) changes its tip.
      watch = new MutationObserver(() => {
        take(b);
        if (shown) show();
      });
      watch.observe(b, { attributes: true, attributeFilter: ["title"] });
      timer = window.setTimeout(show, carry ? 0 : REST);
    };
    const leave = (e: PointerEvent) => {
      if (!e.relatedTarget) hide();
    };
    // A press, a key, a scroll or leaving the window puts the tip away.
    const away = () => {
      hide();
      gone = 0;
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", leave);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", away, true);
    document.addEventListener("scroll", away, true);
    window.addEventListener("blur", away);
    return () => {
      hide();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", away, true);
      document.removeEventListener("scroll", away, true);
      window.removeEventListener("blur", away);
    };
  }, []);

  // Under the button, kept inside the window; above it when there is no room below.
  useLayoutEffect(() => {
    const d = box.current;
    if (!d || !tip) return;
    const w = d.offsetWidth;
    const h = d.offsetHeight;
    const left = Math.min(Math.max(8, tip.x - w / 2), window.innerWidth - w - 8);
    const below = tip.bottom + 6 + h <= window.innerHeight - 8;
    d.style.left = `${left}px`;
    d.style.top = `${below ? tip.bottom + 6 : tip.top - 6 - h}px`;
    d.style.visibility = "visible";
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={box} className="tip" role="tooltip">
      {tip.text}
      {tip.keys && <kbd>{tip.keys}</kbd>}
    </div>,
    document.body,
  );
}
