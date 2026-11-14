import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { MessageQuote } from "@finx/client";
import { Icon } from "../icons";
import { useStore } from "../store";
import { addQuote, copy, selection, selectionQuote } from "./contentMenus";

// The bar that comes up by words selected in the conversation (message-quote-design §4.2): Quote
// when the selection is one message's words, and Copy. It shows once the selecting is done (the
// pointer let go, or the keys at rest), follows the words as the conversation scrolls, and goes
// with the selection.

/** Where the selected words are on screen, and the part of the window the bar may sit in. */
type Place = { first: DOMRect; last: DOMRect; within: { top: number; bottom: number; left: number; right: number } };
type Shown = { text: string; quote: MessageQuote | null; place: Place };

const GAP = 8;

function placeOf(): Place | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return null;
  const at = range.commonAncestorContainer;
  const box = (at instanceof Element ? at : at.parentElement)?.closest(".cscroll, .dwrap")?.getBoundingClientRect();
  const within = box ? { top: box.top, bottom: box.bottom, left: box.left, right: box.right } : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  return { first: rects[0], last: rects[rects.length - 1], within };
}

function read(): Shown | null {
  const text = selection();
  if (text.trim() === "") return null;
  const place = placeOf();
  return place ? { text, quote: selectionQuote(), place } : null;
}

export function SelectionBar() {
  const { t } = useTranslation("session");
  const st = useStore();
  const [shown, setShown] = useState<Shown | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let pressing = false;
    let timer = 0;
    let quiet = false;
    const later = (ms: number) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setShown(pressing ? null : read()), ms);
    };
    const down = (e: PointerEvent) => {
      if (bar.current?.contains(e.target as Node)) return;
      // A right-click brings the menu, which has the same two: the bar steps aside until the selection changes.
      quiet = e.button === 2;
      pressing = true;
      clearTimeout(timer);
      setShown(null);
    };
    // The browser settles a click's selection (a click inside one clears it) after the pointer is up.
    const up = () => {
      pressing = false;
      if (!quiet) later(10);
    };
    const changed = () => {
      quiet = false;
      if (!pressing) later(window.getSelection()?.isCollapsed ? 0 : 160);
    };
    const moved = () => setShown((was) => (was ? read() : was));
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShown(null);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("selectionchange", changed);
    document.addEventListener("scroll", moved, { capture: true, passive: true });
    document.addEventListener("keydown", key);
    window.addEventListener("resize", moved);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("scroll", moved, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", moved);
    };
  }, []);

  // Over the first selected line, in the middle of it; under the last when the first is out of
  // sight; at the top of the conversation when both are (a selection longer than the window).
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || !shown) return;
    const { first, last, within } = shown.place;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let top = first.top - h - GAP;
    let under = false;
    if (top < within.top + 4) {
      under = last.bottom + GAP + h <= within.bottom - 4;
      top = under ? last.bottom + GAP : within.top + GAP;
    }
    const line = under ? last : first;
    const left = Math.min(Math.max(line.left + line.width / 2 - w / 2, within.left + 8), Math.max(within.left + 8, within.right - w - 8));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.dataset.under = under ? "true" : "false";
  }, [shown]);

  if (!shown) return null;
  const { text, quote } = shown;
  return createPortal(
    // Pressing the bar keeps the selection it acts on.
    <div className="selbar" role="toolbar" aria-label={t("content.selectionActions")} ref={bar} onMouseDown={(e) => e.preventDefault()}>
      {quote && (
        <button
          className="selbar-b quote"
          onClick={() => {
            addQuote(st, quote);
            window.getSelection()?.removeAllRanges();
            setShown(null);
          }}
        >
          <Icon name="quote" className="sm" />
          {t("content.quote")}
        </button>
      )}
      {quote && <span className="selbar-sep" aria-hidden="true" />}
      <button
        className="selbar-b"
        onClick={() => {
          copy(st, text, t("content.copied"));
          setShown(null);
        }}
      >
        <Icon name="copy" className="sm" />
        {t("content.copy")}
      </button>
    </div>,
    document.body,
  );
}
