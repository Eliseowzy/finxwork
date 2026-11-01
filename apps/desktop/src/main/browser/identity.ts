import type { Language } from "../../shared/i18n.ts";
import { browserUserAgent } from "./url.ts";

// How a tab of the embedded browser presents itself to sites, as a Chrome of the version
// Electron runs would (browser-design §8.3.5): the reduced user agent, client hints that name
// Google Chrome (the Sec-CH-UA headers and navigator.userAgentData), and one list of
// languages for the header and the page alike. Electron leaves the client hints out once the
// user agent is changed, and an agent that says Chrome while its hints don't is easy to tell.

export type Platform = { os: NodeJS.Platform; arch: string; systemVersion: string };

const osName = (os: NodeJS.Platform) => (os === "darwin" ? "macOS" : os === "win32" ? "Windows" : "Linux");

/** The languages a Chrome in the app's language prefers, as CDP takes them (it adds the q= weights to the header itself). */
export function acceptLanguage(language: Language): string {
  return language === "zh-CN" ? "zh-CN,zh" : "en-US,en";
}

/** The brands Chromium of this version names, then the real ones. */
function brandsOf(chromeVersion: string) {
  const major = chromeVersion.split(".")[0];
  return [
    { brand: "Not?A_Brand", version: "24" },
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
  ];
}

/** Whether Chrome sends client hints to this URL: secure origins, this machine included. */
export function hintsGo(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "wss:") return true;
    const host = u.hostname;
    return (u.protocol === "http:" || u.protocol === "ws:") && (host === "localhost" || host.endsWith(".localhost") || host.startsWith("127.") || host === "[::1]");
  } catch {
    return false;
  }
}

/** The client hints Chrome sends with every request to a secure origin. Electron sends none once
 * the user agent is changed, whatever the page's override says, so the session adds them. */
export function clientHintHeaders(chromeVersion: string, os: NodeJS.Platform): Record<string, string> {
  return {
    "sec-ch-ua": brandsOf(chromeVersion).map((b) => `"${b.brand}";v="${b.version}"`).join(", "),
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"${osName(os)}"`,
  };
}

/** `Emulation.setUserAgentOverride` for a tab: what sites read, whichever way they ask. */
export function chromeOverride(ua: string, chromeVersion: string, language: Language, p: Platform) {
  const brands = brandsOf(chromeVersion);
  return {
    userAgent: browserUserAgent(ua),
    acceptLanguage: acceptLanguage(language),
    platform: p.os === "darwin" ? "MacIntel" : p.os === "win32" ? "Win32" : "Linux x86_64",
    userAgentMetadata: {
      brands,
      fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === "Not?A_Brand" ? "24.0.0.0" : chromeVersion })),
      fullVersion: chromeVersion,
      platform: osName(p.os),
      platformVersion: p.systemVersion,
      architecture: p.arch.startsWith("arm") ? "arm" : "x86",
      model: "",
      mobile: false,
      bitness: p.arch.endsWith("64") ? "64" : "32",
      wow64: false,
      formFactors: ["Desktop"],
    },
  };
}
