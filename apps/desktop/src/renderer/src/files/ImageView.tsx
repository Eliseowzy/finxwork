import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// An image in the file panel: fitted to the panel at first; a trackpad pinch (or ⌘/Ctrl and the
// wheel) zooms about the point under the fingers, two-finger scrolling or a drag moves it, and a
// double click zooms in there or goes back to fitted.

/** The room kept round the image, as `.fpn-img-in`'s padding. */
const pad = 12;
/** How far past fitted a pinch goes. */
const maxZoom = 20;

type Anchor = { fx: number; fy: number; x: number; y: number };

export function ImageView({ src, alt }: { src: string; alt: string }) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  /** How many times the fitted size. */
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** The point to keep under the pointer once the new size is laid out. */
  const anchor = useRef<Anchor | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Never larger than the panel at first, nor blown up past its own size.
  const fit = natural && room ? Math.min(1, Math.max(1, room.w - 2 * pad) / natural.w, Math.max(1, room.h - 2 * pad) / natural.h) : 1;
  const size = natural ? { width: natural.w * fit * zoom, height: natural.h * fit * zoom } : undefined;

  /** Zoom to `next` keeping the image point under (x, y) where it is. */
  const zoomAt = (next: number, x: number, y: number) => {
    const r = img.current?.getBoundingClientRect();
    next = Math.min(maxZoom, Math.max(1, next));
    if (!r || !r.width || next === zoomRef.current) return;
    anchor.current = { fx: (x - r.left) / r.width, fy: (y - r.top) / r.height, x, y };
    zoomRef.current = next;
    setZoom(next);
  };

  useLayoutEffect(() => {
    const a = anchor.current;
    const el = box.current;
    const r = img.current?.getBoundingClientRect();
    if (!a || !el || !r) return;
    anchor.current = null;
    el.scrollLeft += r.left + a.fx * r.width - a.x;
    el.scrollTop += r.top + a.fy * r.height - a.y;
  }, [zoom]);

  // Chromium sends a trackpad pinch as a control-modified wheel event.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY) zoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  // A drag moves a zoomed image.
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: ReactPointerEvent) => {
    const el = box.current;
    if (e.button !== 0 || !el || zoom === 1) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    const el = box.current;
    if (!d || !el) return;
    el.scrollLeft = d.left - (e.clientX - d.x);
    el.scrollTop = d.top - (e.clientY - d.y);
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };

  const zoomed = zoom > 1;
  return (
    <div
      ref={box}
      className={`fpn-img${zoomed ? " zoomed" : ""}${dragging ? " dragging" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => zoomAt(zoomed ? 1 : 2.5, e.clientX, e.clientY)}
    >
      <div className="fpn-img-in">
        <img
          ref={img}
          src={src}
          alt={alt}
          draggable={false}
          style={size ?? { visibility: "hidden", position: "absolute" }}
          onLoad={(e) => {
            const i = e.currentTarget;
            // An SVG without a size of its own: as large as the panel.
            setNatural(i.naturalWidth && i.naturalHeight ? { w: i.naturalWidth, h: i.naturalHeight } : { w: box.current?.clientWidth ?? 300, h: box.current?.clientHeight ?? 150 });
          }}
        />
      </div>
    </div>
  );
}
