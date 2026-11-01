// What the person types in the browser panel's address field, as a URL to open.

/** A URL as typed: kept when it has a scheme the panel opens, else https (http for this machine) in front; null for nothing to open. */
export function typedURL(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/^(https?|file):/i.test(t) || t === "about:blank") return t;
  // `host:port` is not a scheme; anything else with one (javascript:, chrome:) is not opened.
  const hostPort = /^[^/:]+:\d+(\/|$)/.test(t);
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !hostPort) return null;
  if (/\s/.test(t)) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t);
  return `${local ? "http" : "https"}://${t}`;
}
