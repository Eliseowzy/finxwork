import { allEngines, engineById, engineByKeyword, searchURL, type SearchEngine } from "../../shared/search.ts";
import { topLevelDomains } from "../../shared/tlds.ts";

// The embedded browser's web-facing strings: what the person types in the address field, as a
// URL to open (or a search), and the user agent sites see.

export type SearchSettings = {
  engines?: readonly SearchEngine[];
  /** The default engine's id. */
  engine?: string;
  /** The person picked this engine for this search (keyword mode): always a search, with it. */
  keyword?: string;
};

/**
 * What the address field opens for the text typed, as Chrome decides it:
 * - a URL with a scheme the panel opens, as is (any other scheme: nothing);
 * - an address, with https in front (http for this machine): a host that ends in a real
 *   top-level domain ("example.com", not "readme.txt" or "v1.2"), this machine, an IP
 *   address, or `host:port`;
 * - "keyword words", where the keyword is an engine's: a search with that engine;
 * - anything else: a search with the default engine.
 */
export function typedURL(text: string, settings: SearchSettings = {}): string | null {
  const engines = settings.engines ?? allEngines();
  const t = text.trim();
  if (!t) return null;
  if (settings.keyword) {
    const picked = engines.find((e) => e.id === settings.keyword);
    if (picked) return searchURL(picked, t);
  }
  if (/^(https?|file):/i.test(t) || t === "about:blank") return t;
  const space = t.search(/\s/);
  if (space > 0) {
    const named = engineByKeyword(engines, t.slice(0, space));
    if (named) return searchURL(named, t.slice(space).trim());
  }
  if (space < 0) {
    const host = t.split(/[/?#]/)[0];
    const hostPort = /^[^:]+:\d{1,5}$/.test(host);
    // `host:port` is not a scheme; anything else with one (javascript:, chrome:) is not opened.
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !hostPort) return null;
    if (isAddress(host)) return `${isLocal(host) ? "http" : "https"}://${t}`;
  }
  return searchURL(engineById(engines, settings.engine), t);
}

/** This machine: opened over http, as dev servers serve it. */
function isLocal(hostPort: string): boolean {
  const host = hostPort.replace(/:\d{1,5}$/, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host.startsWith("127.") || host === "[::1]";
}

/** A host as typed, maybe with a port: one the address field opens. */
function isAddress(hostPort: string): boolean {
  if (/^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(hostPort)) return true;
  const host = hostPort.replace(/:\d{1,5}$/, "").toLowerCase();
  if (hostPort !== host && /^[a-z0-9-]+$/.test(host)) return true; // myserver:8080
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split(".").every((n) => Number(n) <= 255);
  const labels = host.replace(/\.$/, "").split(".");
  if (labels.length < 2 || labels.some((l) => !l || /[\s/\\@]/.test(l))) return false;
  return topLevelDomains.has(labels[labels.length - 1]);
}

/** Electron's user agent without its own token and the app's, and with the version reduced to
 * `<major>.0.0.0`: what Chrome sends. */
export function browserUserAgent(ua: string): string {
  return ua
    .split(" ")
    .filter((token) => !/^(Electron|FinxWork|finxwork)\//i.test(token))
    .map((token) => token.replace(/^Chrome\/(\d+)[\d.]*$/, "Chrome/$1.0.0.0"))
    .join(" ");
}
