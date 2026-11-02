import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useStore } from "./store";

// A site's icon wherever a site is shown with one (browser-design §10.2): the site permissions,
// a site's approval, the search engines, a web page's element in the composer. finx finds it
// the way a browser does and keeps it on disk (`browser/site_icon`); a window asks once a site.
// Only https sites have one to ask for; the others keep what stands for them (a globe, an
// initial).

const asked = new Map<string, Promise<string | null>>();

/** The origin of an https URL, whose site may have an icon; null for anything else. */
export function siteOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** The site's icon as a data URL once finx gives it; null until then, or when it has none. With `el`, asked only once that is on screen. */
export function useSiteIcon(origin: string | null, el?: RefObject<Element | null>): string | null {
  const st = useStore();
  const [icon, setIcon] = useState<string | null>(null);
  const [seen, setSeen] = useState(!el);
  useEffect(() => {
    const node = el?.current;
    if (seen || !node || !origin) return;
    const watch = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "200px" });
    watch.observe(node);
    return () => watch.disconnect();
  }, [el, seen, origin]);
  useEffect(() => {
    setIcon(null);
    const rpc = st.rpc;
    if (!rpc || !seen || !origin) return;
    let ask = asked.get(origin);
    if (!ask) {
      ask = rpc.request("browser/site_icon", { origin }).then(
        (r) => r.icon ?? null,
        () => (asked.delete(origin), null),
      );
      asked.set(origin, ask);
    }
    let live = true;
    void ask.then((src) => live && setIcon(src));
    return () => {
      live = false;
    };
  }, [st.rpc, seen, origin]);
  return icon;
}

/** A site's icon, or `fallback` until it comes or when there is none; asked once it is on screen. */
export function SiteIcon({ origin, fallback, className = "" }: { origin: string | null; fallback: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const icon = useSiteIcon(origin, ref);
  const [broken, setBroken] = useState(false);
  return (
    <span className={`site-ic ${className}`} ref={ref}>
      {icon && !broken ? <img src={icon} alt="" draggable={false} decoding="async" onError={() => setBroken(true)} /> : fallback}
    </span>
  );
}
