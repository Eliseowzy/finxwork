import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useStore } from "./store";

// A site's icon wherever a site is shown with one (browser-design §10.2): the site permissions,
// a site's approval, the search engines, a web page's element in the composer. finx finds it
// the way a browser does and keeps it on disk (`browser/site_icon`); a window asks once a site.
// Only https sites have one to ask for; the others keep what stands for them (a globe, an
// initial).

const asked = new Map<string, Promise<string | null>>();
/** Asked for only what finx keeps (a reply's links, content-actions-design §5.1): the site itself is never asked. */
const kept = new Map<string, Promise<string | null>>();

/** The origin of an https URL, whose site may have an icon; null for anything else. */
export function siteOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The site's icon as a data URL once finx gives it; null until then, or when it has none. With
 * `el`, asked only once that is on screen. `cached`: only an icon finx already keeps.
 */
export function useSiteIcon(origin: string | null, el?: RefObject<Element | null>, cached = false): string | null {
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
    const kind = cached ? kept : asked;
    let ask = asked.get(origin) ?? kind.get(origin);
    if (!ask) {
      ask = rpc.request("browser/site_icon", cached ? { origin, cached: true } : { origin }).then(
        (r) => r.icon ?? null,
        () => (kind.delete(origin), null),
      );
      kind.set(origin, ask);
    }
    let live = true;
    void ask.then((src) => live && setIcon(src));
    return () => {
      live = false;
    };
  }, [st.rpc, seen, origin, cached]);
  return icon;
}

/** A site's icon, or `fallback` until it comes or when there is none; asked once it is on screen (`cached`: only one finx keeps). */
export function SiteIcon({ origin, fallback, className = "", cached = false }: { origin: string | null; fallback: ReactNode; className?: string; cached?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const icon = useSiteIcon(origin, ref, cached);
  const [broken, setBroken] = useState(false);
  return (
    <span className={`site-ic ${className}`} ref={ref}>
      {icon && !broken ? <img src={icon} alt="" draggable={false} decoding="async" onError={() => setBroken(true)} /> : fallback}
    </span>
  );
}
