import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// Liquid glass, drawn by the page: what lies behind a capsule bends at its
// rim as through a lens, each colour by a slightly different amount, and is
// softened and lit. Chromium (and so the app) takes an SVG filter as a
// backdrop-filter; the filter's displacement map is drawn to the capsule's
// own size, so its rim bends the same however wide the capsule is. The
// system's own glass (NSGlassEffectView) can sit only behind the whole page,
// and this sees only the page, not the desktop: it is for the parts that
// float over the conversation.

/** How far the rim bends what is behind it, in px; green and blue a step further each. */
const bend = -38;
const split = 5;

/** The displacement map: mid grey (no shift) inside, a red ramp across and a blue ramp down at the rim. */
function displacementMap(w: number, h: number): string {
  const r = h / 2;
  const rim = Math.max(2, Math.min(w, h) * 0.12);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>
<linearGradient id="x" x1="100%" y1="0%" x2="0%" y2="0%"><stop offset="0%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#f00"/></linearGradient>
<linearGradient id="y" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#00f"/></linearGradient>
</defs>
<rect width="${w}" height="${h}" fill="#000"/>
<rect width="${w}" height="${h}" rx="${r}" fill="url(#x)"/>
<rect width="${w}" height="${h}" rx="${r}" fill="url(#y)" style="mix-blend-mode:difference"/>
<rect x="${rim}" y="${rim}" width="${w - 2 * rim}" height="${h - 2 * rim}" rx="${r - rim}" fill="hsl(0 0% 50% / .94)" style="filter:blur(${rim * 0.9}px)"/>
</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

/** One colour of the backdrop, shifted by the map. */
function Channel({ scale, keep, name }: { scale: number; keep: "r" | "g" | "b"; name: string }) {
  // Each output channel takes only its own input channel, so the three blend back together by screen.
  const values = [
    keep === "r" ? "1 0 0 0 0" : "0 0 0 0 0",
    keep === "g" ? "0 1 0 0 0" : "0 0 0 0 0",
    keep === "b" ? "0 0 1 0 0" : "0 0 0 0 0",
    "0 0 0 1 0",
  ].join(" ");
  return (
    <>
      <feDisplacementMap in="soft" in2="map" scale={scale} xChannelSelector="R" yChannelSelector="B" result={`${name}d`} />
      <feColorMatrix in={`${name}d`} type="matrix" values={values} result={name} />
    </>
  );
}

/** A capsule of liquid glass around toolbar buttons. */
export function Glass({ children, className = "" }: { children: ReactNode; className?: string }) {
  const id = "lg" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      setSize((old) => (old && old.w === w && old.h === h ? old : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={`glass ${className}`} style={size ? { backdropFilter: `url(#${id})` } : undefined}>
      {size && (
        <svg className="glass-defs" aria-hidden width="0" height="0">
          <filter id={id} x="0" y="0" width={size.w} height={size.h} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feImage x="0" y="0" width={size.w} height={size.h} preserveAspectRatio="none" href={displacementMap(size.w, size.h)} result="map" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="blurred" />
            <feColorMatrix in="blurred" type="saturate" values="1.7" result="soft" />
            <Channel scale={bend} keep="r" name="r" />
            <Channel scale={bend - split} keep="g" name="g" />
            <Channel scale={bend - 2 * split} keep="b" name="b" />
            <feBlend in="r" in2="g" mode="screen" result="rg" />
            <feBlend in="rg" in2="b" mode="screen" />
          </filter>
        </svg>
      )}
      {children}
    </div>
  );
}
