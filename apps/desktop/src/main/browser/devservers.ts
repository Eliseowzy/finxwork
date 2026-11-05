import { execFile } from "node:child_process";
import http from "node:http";
import type { DevServer } from "../../shared/bridge";

// The web servers running on this machine, for the embedded browser's new tab: the system says
// which TCP ports are listening and by whom, and each is asked for its front page. Only those
// that answer with HTML are kept, by their title and, where it shows, the tool that serves them.

/** A listening socket as the system lists it. */
export type Listener = { port: number; host: string; pid: number; process: string };

/** Ports that are not a web page anyone opens: databases, caches, debuggers, system services. */
const notWeb = new Set([22, 25, 53, 111, 135, 139, 445, 631, 3306, 5432, 6379, 9229, 11211, 27017]);
/** System processes that listen with HTTP of their own (AirPlay, printing, Handoff). */
const systemProcesses = new Set(["ControlCenter", "rapportd", "cupsd", "sharingd", "AirPlayXPCHelper"]);
/** At most this many ports asked: a machine full of listeners must not make the new tab wait. */
const maxProbes = 32;
const probeTimeout = 400;
const listTimeout = 1500;
const maxBody = 32 * 1024;

/** The address a socket listens on, as reachable from this machine: loopback or every interface. */
export function local(host: string): boolean {
  return ["*", "0.0.0.0", "::", "[::]", "127.0.0.1", "::1", "[::1]", "localhost"].includes(host) || /^127\./.test(host);
}

/** Splits `host:port`, the host maybe `[v6]`. */
function hostPort(addr: string): { host: string; port: number } | null {
  const i = addr.lastIndexOf(":");
  if (i < 0) return null;
  const port = Number(addr.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: addr.slice(0, i).replace(/%.*$/, ""), port };
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`: a `p` line starts a process, `c` names it, each `n` is a socket. */
export function parseLsof(out: string): Listener[] {
  const found: Listener[] = [];
  let pid = 0;
  let name = "";
  for (const line of out.split("\n")) {
    const tag = line[0];
    const value = line.slice(1).trim();
    if (tag === "p") (pid = Number(value)), (name = "");
    else if (tag === "c") name = value;
    else if (tag === "n") {
      const hp = hostPort(value);
      if (hp) found.push({ ...hp, pid, process: name });
    }
  }
  return found;
}

/** `ss -ltnpH`: `LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=123,fd=20))`. */
export function parseSs(out: string): Listener[] {
  const found: Listener[] = [];
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "LISTEN" || cols.length < 4) continue;
    const hp = hostPort(cols[3]);
    if (!hp) continue;
    const users = /\("([^"]*)",pid=(\d+)/.exec(line);
    found.push({ ...hp, pid: users ? Number(users[2]) : 0, process: users?.[1] ?? "" });
  }
  return found;
}

/** `netstat -ano` on Windows, with process names from `tasklist /FO CSV /NH`. */
export function parseNetstat(out: string, tasks: string): Listener[] {
  const names = new Map<number, string>();
  for (const line of tasks.split("\n")) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m) names.set(Number(m[2]), m[1].replace(/\.exe$/i, ""));
  }
  const found: Listener[] = [];
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "TCP" || cols[3] !== "LISTENING") continue;
    const hp = hostPort(cols[1]);
    if (!hp) continue;
    const pid = Number(cols[4]);
    found.push({ ...hp, pid, process: names.get(pid) ?? "" });
  }
  return found;
}

/** The ports worth asking, once each: listening here, not a known non-web port, not ours (`ownPorts`: the app's own dev server). */
export function candidates(listeners: Listener[], own: Set<number>, ownPorts = new Set<number>()): Listener[] {
  const byPort = new Map<number, Listener>();
  for (const l of listeners) {
    if (!local(l.host) || notWeb.has(l.port) || own.has(l.pid) || ownPorts.has(l.port) || systemProcesses.has(l.process)) continue;
    // One socket per port is enough to ask; IPv4 loopback first, as most servers answer there.
    const had = byPort.get(l.port);
    if (!had || (had.host.includes(":") && !l.host.includes(":"))) byPort.set(l.port, l);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port).slice(0, maxProbes);
}

/** The page's title, its entities undone. */
export function titleOf(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return "";
  return m[1]
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The tool serving the page, when its page or headers give it away. */
export function frameworkOf(html: string, headers: http.IncomingHttpHeaders): string | undefined {
  const powered = String(headers["x-powered-by"] ?? "");
  const server = String(headers.server ?? "");
  if (/__NEXT_DATA__|\/_next\//.test(html) || /next\.js/i.test(powered)) return "Next.js";
  if (/__NUXT__|\/_nuxt\//.test(html) || /nuxt/i.test(powered)) return "Nuxt";
  if (/__sveltekit/.test(html)) return "SvelteKit";
  if (/\/@vite\/client/.test(html)) return "Vite";
  if (/webpack-dev-server|\/webpack-dev-server\.js/.test(html)) return "webpack";
  if (/astro-island|\/@astrojs\//.test(html)) return "Astro";
  if (/werkzeug/i.test(server)) return "Flask";
  if (/WSGIServer/i.test(server)) return "Django";
  if (/express/i.test(powered)) return "Express";
  return undefined;
}

/** Asks a port for its front page; the server when it answers with HTML (or sends the browser on). */
function probe(l: Listener): Promise<DevServer | null> {
  const host = l.host.includes(":") && !["::", "[::]"].includes(l.host) ? "::1" : "127.0.0.1";
  return new Promise((resolve) => {
    const req = http.get({ host, port: l.port, path: "/", timeout: probeTimeout, headers: { accept: "text/html", "user-agent": "FinxWork" } }, (res) => {
      const status = res.statusCode ?? 0;
      const type = String(res.headers["content-type"] ?? "");
      const redirect = status >= 300 && status < 400 && !!res.headers.location;
      // An error page is not a site: a proxy's 405, an API's 404. A sign-in wall (401) is.
      const ok = (status >= 200 && status < 300) || status === 401;
      if (!redirect && !(ok && /text\/html/i.test(type))) {
        res.destroy();
        return resolve(null);
      }
      let body = "";
      res.setEncoding("utf8");
      const done = () => {
        res.destroy();
        resolve({ port: l.port, url: `http://localhost:${l.port}/`, title: titleOf(body), framework: frameworkOf(body, res.headers), process: l.process, pid: l.pid });
      };
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length >= maxBody) done();
      });
      res.on("end", done);
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

/** A command's output, whatever its exit code (lsof exits 1 when it finds nothing); empty when it cannot run. */
function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: listTimeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (_err, stdout) => resolve(String(stdout ?? "")));
  });
}

async function listeners(): Promise<Listener[]> {
  if (process.platform === "win32") {
    // Without -p, netstat lists IPv4 and IPv6 sockets both, each as TCP.
    const [net, tasks] = await Promise.all([run("netstat", ["-ano"]), run("tasklist", ["/FO", "CSV", "/NH"])]);
    return parseNetstat(net, tasks);
  }
  // The app started from the Dock has a short PATH: lsof by its place on macOS.
  const lsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
  const out = await run(lsof, ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
  if (out.trim() || process.platform === "darwin") return parseLsof(out);
  return parseSs(await run("ss", ["-ltnpH"]));
}

/** In development the app's own pages come from a dev server: not one to offer. */
function ownPorts(): Set<number> {
  const url = process.env.ELECTRON_RENDERER_URL;
  if (!url) return new Set();
  try {
    const u = new URL(url);
    return new Set([Number(u.port || (u.protocol === "https:" ? 443 : 80))]);
  } catch {
    return new Set();
  }
}

let inFlight: Promise<DevServer[]> | null = null;

/** The web servers on this machine now, by port; `own` are the app's own processes, left out. */
export function devServers(own: Set<number>): Promise<DevServer[]> {
  inFlight ??= (async () => {
    try {
      const found = await Promise.all(candidates(await listeners(), own, ownPorts()).map(probe));
      return found.filter((s): s is DevServer => s !== null);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Whether a process is still there (EPERM: it is, only not ours to signal). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const stopGrace = 3000;

/**
 * Stops the server the new tab offered on `port`: only if the process listening there now is still
 * `pid` (the one the card showed) and one the new tab would offer, so a port taken over meanwhile,
 * or the app itself, is never hit. Asked to quit first; ended outright when it has not after a while.
 */
export async function stopDevServer(port: number, pid: number, own: Set<number>): Promise<"stopped" | "gone" | "denied"> {
  const here = candidates(await listeners(), own, ownPorts()).find((l) => l.port === port);
  if (!here || here.pid !== pid || pid <= 0) return "gone";
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "denied";
  }
  for (const until = Date.now() + stopGrace; Date.now() < until; ) {
    if (!alive(pid)) return "stopped";
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone between the last look and now.
  }
  return "stopped";
}
