import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpProbeResult, McpProbeStep, McpProbeStepId, McpServerConfig } from "@finx/protocol";
import { Dialog } from "../components";
import { Icon } from "../icons";
import { errorText, useStore } from "../store";
import { localIdentity, remoteIdentity } from "../../../shared/identity";
import { credentialName, joinCommand, splitCommand } from "./model";
import { PopUp, ServerTile, type Choice } from "./parts";
import type { Customize } from "./useCustomize";

// 添加 › 添加连接器 (customize-design §10.9; the steps are docs/desktop/connector-add-demo.html,
// the settings a grouped form as docs/desktop/connector-add-grouped-demo.html):
// a name and an address first. A remote address is checked (mcp/probe), then its sign-in is
// set up with what the check found; a command gets its form and is checked when added.
// Nothing is written before a check passes, unless the person adds it anyway (DD-54).

type Row = { key: string; value: string; locked: boolean };
type Detected =
  | { kind: "remote"; url: string; host: string; insecure: boolean; sse: boolean; json?: boolean; name?: string; headers: Row[] }
  | { kind: "local"; argv: string[]; env: Row[]; json?: boolean; name?: string }
  | { kind: "bad"; why: string };
type Step = "entry" | "check" | "remote" | "local" | "login" | "done";
type Auth = "oauth" | "token" | "none";
// Which client finx signs in as: finx finds one on its own (a published identity, else a
// registration; the order is the kernel's), or the person's own OAuth app.
type Client = "auto" | "own";

const secretish = /token|key|secret|password|passwd|auth|cookie|credential/i;
const row = (key: string, value: string): Row => ({ key, value, locked: secretish.test(key) && !!value });
const REMOTE_STEPS: McpProbeStepId[] = ["connect", "resource", "auth_server"];
const LOCAL_STEPS: McpProbeStepId[] = ["start", "handshake", "tools"];

/** What the address box holds: a remote address, a command line (with leading VAR=value), or JSON. */
export function detect(text: string): Detected | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith("{")) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      return { kind: "bad", why: "json" };
    }
    const o = v as Record<string, unknown>;
    const isServer = (x: unknown): boolean => !!x && typeof x === "object" && ("command" in (x as object) || "url" in (x as object));
    const table = (isServer(o) ? { "": o } : (o["mcpServers"] ?? o["mcp_servers"] ?? o["servers"] ?? o)) as Record<string, unknown>;
    const found = Object.entries(table ?? {}).find(([, s]) => isServer(s)) as [string, Record<string, unknown>] | undefined;
    if (!found) return { kind: "bad", why: "jsonServer" };
    const [name, s] = found;
    const rows = (m: unknown) => Object.entries((m as Record<string, unknown>) ?? {}).map(([k, val]) => row(k, String(val ?? "")));
    const inner = typeof s.url === "string" ? detect(s.url) : detect(joinCommand(String(s.command), Array.isArray(s.args) ? s.args.map(String) : []));
    if (!inner || inner.kind === "bad") return inner;
    return inner.kind === "remote" ? { ...inner, json: true, name: name || undefined, headers: rows(s.headers) } : { ...inner, json: true, name: name || undefined, env: rows(s.env) };
  }
  if (/^https?:\/\//i.test(t)) {
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      return { kind: "bad", why: "url" };
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return { kind: "remote", url: t, host: u.hostname, insecure: u.protocol === "http:" && !local, sse: /\/sse\/?$/.test(u.pathname), headers: [] };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return { kind: "bad", why: "scheme" };
  const argv = splitCommand(t);
  const env: Row[] = [];
  while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
    const [k, ...v] = argv.shift()!.split("=");
    env.push(row(k, v.join("=")));
  }
  if (!argv.length) return { kind: "bad", why: "onlyVars" };
  return { kind: "local", argv, env };
}

/** The name to offer when none is typed: the host's telling part, or the package's. */
export function suggestName(d: Detected | null): string {
  if (!d || d.kind === "bad") return "";
  if (d.name) return d.name;
  let n: string;
  if (d.kind === "remote") {
    const parts = d.host.split(".").filter((p) => !["mcp", "api", "www", "server"].includes(p));
    n = parts.length > 1 ? parts[parts.length - 2] : (parts[0] ?? d.host);
  } else {
    const pkg = d.argv.slice(1).find((a) => !a.startsWith("-") && !["dlx", "run", "x"].includes(a)) ?? d.argv[0];
    const bare = pkg.replace(/(?<=.)@[^@/]+$/, "");
    const [scope, last] = bare.startsWith("@") ? bare.slice(1).split("/") : [null, bare.split("/").pop() ?? bare];
    n = (last ?? "").replace(/\.(py|js|ts)$/, "").replace(/^(mcp-server-|server-|mcp-)/, "").replace(/(-mcp-server|-mcp|-server)$/, "");
    if (!n || n === "mcp") n = scope ?? "local";
  }
  return n
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function Rows({ rows, set, keyHint, valueHint }: { rows: Row[]; set: (rows: Row[]) => void; keyHint: string; valueHint: string }) {
  const { t } = useTranslation("customize");
  const change = (i: number, patch: Partial<Row>) => set(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="cz-kvs">
      {rows.map((r, i) => (
        <div key={i} className="cz-kvrow">
          <input className="field mono" value={r.key} placeholder={keyHint} spellCheck={false} onChange={(e) => change(i, { key: e.target.value, locked: r.locked || (secretish.test(e.target.value) && !r.value) })} />
          <input className="field mono" type={r.locked ? "password" : "text"} value={r.value} placeholder={r.locked ? t("addc.keychain") : valueHint} spellCheck={false} onChange={(e) => change(i, { value: e.target.value })} />
          <button className={`cz-lock ${r.locked ? "on" : ""}`} title={r.locked ? t("addc.locked") : t("addc.unlocked")} onClick={() => change(i, { locked: !r.locked })}>
            <Icon name={r.locked ? "lock" : "unlock"} />
          </button>
          <button className="cz-lock" title={t("addc.removeRow")} onClick={() => set(rows.filter((_, j) => j !== i))}>
            <Icon name="x" />
          </button>
        </div>
      ))}
      <button className="link cz-addrow" onClick={() => set([...rows, { key: "", value: "", locked: false }])}>
        <Icon name="plus" />
        {t("addc.addRow")}
      </button>
    </div>
  );
}

export function AddConnector({ c, project, onClose, onAdded, onOpen }: { c: Customize; project: string | null; onClose: () => void; onAdded: (name: string) => void; onOpen: (name: string) => void }) {
  const { t } = useTranslation("customize");
  const st = useStore();
  const [step, setStep] = useState<Step>("entry");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [errors, setErrors] = useState<{ name?: string; address?: string }>({});
  const [d, setD] = useState<Detected | null>(null);
  const [steps, setSteps] = useState<McpProbeStep[]>([]);
  const [stepIds, setStepIds] = useState<McpProbeStepId[]>(REMOTE_STEPS);
  const [probed, setProbed] = useState<McpProbeResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [auth, setAuth] = useState<Auth>("none");
  const [client, setClient] = useState<Client>("auto");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [token, setToken] = useState("");
  const [header, setHeader] = useState("Authorization");
  const [prefix, setPrefix] = useState("Bearer ");
  const [sendAs, setSendAs] = useState(false);
  const [headers, setHeaders] = useState<Row[]>([]);
  const [transport, setTransport] = useState<"streamable_http" | "sse">("streamable_http");
  const [adv, setAdv] = useState(false);
  const [command, setCommand] = useState("");
  const [env, setEnv] = useState<Row[]>([]);
  const [cwd, setCwd] = useState("");
  const [ladv, setLadv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [back, setBack] = useState<Step>("entry");
  const [tools, setTools] = useState<string[]>([]);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  // Credentials saved for a check, deleted again when the person gives up (DD-54).
  const staged = useRef<string[]>([]);
  const probeId = useRef<string | null>(null);
  const loginWait = useRef<(() => void) | null>(null);
  const rpc = st.rpc;

  useEffect(() => {
    if (!rpc) return;
    return rpc.on("mcp/probe_progress", (p) => {
      if (p.probe_id !== probeId.current) return;
      setSteps((list) => [...list.filter((s) => s.id !== p.step.id), p.step]);
    });
  }, [rpc]);

  const existing = new Set(c.servers.map((s) => s.name));
  // One service, one connector (mcp-design §13.10): the one that already reaches this address.
  const sameAs = (det: Detected | null) => {
    if (!det || det.kind === "bad") return null;
    const id = det.kind === "remote" ? remoteIdentity(det.url) : localIdentity(det.argv[0], det.argv.slice(1));
    return c.servers.find((s) => s.identity === id) ?? null;
  };
  const detected = detect(address);
  const duplicate = sameAs(detected);
  const suggested = name ? "" : suggestName(detected);

  const discard = async () => {
    for (const name of staged.current) await rpc?.request("credentials/delete", { name }).catch(() => {});
    staged.current = [];
  };
  const close = () => {
    if (probeId.current) void rpc?.request("mcp/probe_cancel", { probe_id: probeId.current }).catch(() => {});
    loginWait.current?.();
    if (step !== "done") void discard();
    onClose();
  };

  const stage = async (credential: string, value: string) => {
    await rpc!.request("credentials/set", { name: credential, value });
    if (!staged.current.includes(credential)) staged.current.push(credential);
    return `\${credential:${credential}}`;
  };

  const runProbe = async (server: McpServerConfig, ids: McpProbeStepId[]): Promise<McpProbeResult> => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    probeId.current = id;
    setStepIds(ids);
    setSteps([]);
    try {
      return await rpc!.request("mcp/probe", { probe_id: id, server, cwd: project ?? undefined });
    } finally {
      probeId.current = null;
    }
  };

  const connect = async () => {
    const det = detect(address);
    const n = (name || suggestName(det)).trim();
    const errs: typeof errors = {};
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(n)) errs.name = t("addc.badName");
    else if (existing.has(n)) errs.name = t("addc.taken", { name: n });
    if (!det || det.kind === "bad") errs.address = t(`addc.bad.${det?.kind === "bad" ? det.why : "empty"}` as "addc.bad.empty");
    else if (sameAs(det)) return;
    setErrors(errs);
    if (errs.name || errs.address || !det || det.kind === "bad" || !rpc) return;
    setName(n);
    setD(det);
    if (det.kind === "local") {
      setCommand(joinCommand(det.argv[0], det.argv.slice(1)));
      setEnv(det.env);
      setStep("local");
      return;
    }
    setHeaders(det.headers);
    setTransport(det.sse ? "sse" : "streamable_http");
    await checkRemote(n, det);
  };

  const checkRemote = async (n: string, det: Extract<Detected, { kind: "remote" }>) => {
    setFailure(null);
    setBack("entry");
    setStep("check");
    try {
      const result = await runProbe({ name: n, url: det.url }, REMOTE_STEPS);
      setProbed(result);
      setSteps(result.steps);
      if (result.error) {
        setFailure(result.error);
        return;
      }
      setTransport(result.transport ?? "streamable_http");
      setAuth(result.suggested.auth);
      setClient(result.suggested.client === "own" ? "own" : "auto");
      setTimeout(() => setStep("remote"), 500);
    } catch (e) {
      setFailure(errorText(e));
    }
  };

  /** The remote server as it will be written; secrets as references. */
  const remoteServer = async (): Promise<McpServerConfig> => {
    const det = d as Extract<Detected, { kind: "remote" }>;
    const server: McpServerConfig = { name, url: det.url };
    const urlSays = det.sse ? "sse" : "streamable_http";
    if (transport !== urlSays) server.transport = transport;
    const extra: Record<string, string> = {};
    for (const h of headers.filter((h) => h.key.trim())) extra[h.key.trim()] = h.locked && h.value ? await stage(credentialName(name, `header.${h.key.trim()}`), h.value) : h.value;
    if (auth === "token" && token.trim()) extra[header.trim() || "Authorization"] = `${prefix}${await stage(`mcp.${name}`, token.trim())}`;
    if (Object.keys(extra).length) server.headers = extra;
    if (auth === "oauth") {
      server.auth = "oauth";
      if (client === "own") server.oauth = { client_id: clientId.trim(), ...(clientSecret ? { client_secret: await stage(`mcp.${name}.oauth_secret`, clientSecret) } : {}) };
    }
    return server;
  };

  const localServer = async (): Promise<McpServerConfig> => {
    const argv = splitCommand(command);
    const server: McpServerConfig = { name, command: argv[0], ...(argv.length > 1 ? { args: argv.slice(1) } : {}) };
    const vars: Record<string, string> = {};
    for (const r of env.filter((r) => r.key.trim())) vars[r.key.trim()] = r.locked && r.value ? await stage(credentialName(name, r.key.trim()), r.value) : r.value;
    if (Object.keys(vars).length) server.env = vars;
    if (cwd.trim()) server.cwd = cwd.trim();
    return server;
  };

  /** Writes the server, checks it once, and shows the result. */
  const finish = async (server: McpServerConfig) => {
    const { name: _name, ...settings } = server;
    void _name;
    const { check } = await c.saveServer("user", name, settings as Record<string, unknown>, []);
    staged.current = [];
    const listed = check?.tools.map((tool) => tool.name) ?? [];
    setTools(listed);
    setStep("done");
    onAdded(name);
    st.show(t("toast.serverAdded", { name, count: listed.length }));
  };

  const add = async (mode: Step = step) => {
    if (!rpc) return;
    setBusy(true);
    setFailure(null);
    try {
      if (mode === "local") {
        const server = await localServer();
        setBack("local");
        setStep("check");
        const result = await runProbe(server, LOCAL_STEPS);
        setSteps(result.steps);
        if (result.error) {
          setFailure(result.error);
          setProbed(result);
          return;
        }
        await finish(server);
        return;
      }
      const server = await remoteServer();
      if (auth === "oauth") {
        const login = await rpc.request("mcp/login", { name, cwd: project ?? undefined, server });
        setAuthorizeUrl(login.authorize_url);
        window.finx?.openExternal(login.authorize_url);
        setStep("login");
        const outcome = await new Promise<string | null>((resolve) => {
          const off = rpc.on("mcp/changed", (p) => {
            if (p.login_id !== login.login_id) return;
            off();
            loginWait.current = null;
            resolve(p.login_error ?? null);
          });
          loginWait.current = () => {
            off();
            void rpc.request("mcp/logout", { name }).catch(() => {});
            resolve("cancelled");
          };
        });
        if (outcome === "cancelled") return;
        if (outcome) {
          setFailure(outcome);
          setStep("remote");
          return;
        }
        await finish(server);
        return;
      }
      if (auth === "token" || headers.some((h) => h.value)) {
        // The token is checked before anything is written.
        setBack("remote");
        setStep("check");
        const result = await runProbe(server, REMOTE_STEPS);
        setSteps(result.steps);
        if (result.error) {
          setFailure(result.steps.some((s) => s.http_status === 401) ? t("addc.tokenRefused") : result.error);
          setProbed(result);
          return;
        }
      }
      await finish(server);
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const addAnyway = async () => {
    setBusy(true);
    try {
      await finish(back === "local" ? await localServer() : d?.kind === "remote" ? await remoteServer() : { name });
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const retry = () => {
    if (back === "local" || back === "remote") {
      setStep(back);
      void add(back);
    } else if (d?.kind === "remote") {
      void checkRemote(name, d);
    }
  };
  const edit = () => {
    void discard();
    setFailure(null);
    setStep(back === "check" ? "entry" : back);
  };

  // ── views ──
  const hint = !detected ? null : duplicate ? (
    <div className="cz-detect bad">
      <Icon name="warn" />
      <span>{t("addc.duplicate", { name: duplicate.name })}</span>
      <button className="link" onClick={() => onOpen(duplicate.name)}>
        {t("addc.openIt", { name: duplicate.name })}
      </button>
    </div>
  ) : detected.kind === "bad" ? (
    <div className="cz-detect bad">
      <Icon name="warn" />
      {t(`addc.bad.${detected.why}` as "addc.bad.url")}
    </div>
  ) : detected.kind === "remote" ? (
    <div className="cz-detect">
      <Icon name="globe" />
      <span>
        <b>{t("addc.remote")}</b> · {detected.insecure ? t("addc.insecure") : t("addc.willCheck")}
      </span>
    </div>
  ) : (
    <div className="cz-detect">
      <Icon name="terminal" />
      <span>
        <b>{t("addc.local")}</b> · {detected.argv[0]}
        {detected.env.length > 0 && ` · ${t("addc.vars", { count: detected.env.length })}`}
      </span>
    </div>
  );

  const summary = (editable: boolean) => {
    const remote = d?.kind === "remote";
    return (
      <div className="cz-summary">
        {probed?.icon ? (
          <ServerTile name={name} icon={probed.icon} />
        ) : (
          <div className="cz-tile">
            <Icon name={remote ? "globe" : "terminal"} />
          </div>
        )}
        <div className="t">
          <div className="n">
            {name}
            <span className="badge">{remote ? (transport === "sse" ? t("addc.remoteSse") : t("addc.remoteShort")) : t("addc.local")}</span>
          </div>
          {(remote || step !== "local") && <div className="a mono">{remote ? (d as { url: string }).url : command}</div>}
        </div>
        {editable && (
          <button className="link" onClick={edit}>
            {t("addc.change")}
          </button>
        )}
      </div>
    );
  };

  const stepTitle = (id: McpProbeStepId) => t(`addc.step.${id}` as "addc.step.connect");
  const stepNote = (s: McpProbeStep | undefined): string | null => {
    if (!s?.detail && !(s?.state === "ok" && s.id === "connect")) return s?.detail ?? null;
    if (s.state === "failed") return s.detail ?? null;
    if (s.id === "connect" && s.state === "ok") return s.http_status === 401 ? t("addc.note.needsAuth") : t("addc.note.connected");
    if (s.id === "resource" && s.state === "ok") return t("addc.note.authServer", { issuer: s.detail?.replace(/^authorization server /, "") ?? "" });
    if (s.state === "skipped") return /API key/.test(s.detail ?? "") ? t("addc.note.apiKey") : t("addc.note.noLogin");
    if (s.id === "auth_server") return null;
    if (s.id === "tools") return t("addc.note.tools", { count: Number(s.detail?.split(" ")[0] ?? 0) });
    return s.detail ?? null;
  };
  const stepBadges = (s: McpProbeStep | undefined): string[] => {
    if (!s || s.state !== "ok") return [];
    if (s.id === "connect" && s.http_status) return [String(s.http_status)];
    if (s.id === "resource") return ["OAuth"];
    if (s.id === "auth_server")
      return [/no PKCE/.test(s.detail ?? "") ? t("addc.noPkce") : "PKCE", ...(probed?.suggested.client && probed.suggested.client !== "own" ? [t("addc.cap.auto")] : [])];
    return [];
  };
  const checkView = (
    <>
      {summary(false)}
      <div className="cz-steps-h">
        {failure ? (
          t("addc.checkFailed")
        ) : stepIds.every((id) => steps.some((s) => s.id === id && s.state !== "running")) ? (
          t("addc.checked")
        ) : (
          <>
            <span className="mini-spin cz-spin" />
            {t("addc.checking")}
          </>
        )}
      </div>
      <div className="cz-steps">
        {stepIds.map((id) => {
          const s = steps.find((x) => x.id === id);
          const state = s?.state ?? "wait";
          return (
            <div key={id} className={`stp ${state === "wait" ? "wait" : ""}`}>
              <span className="si">
                {state === "running" ? <span className="mini-spin" /> : state === "ok" ? <span className="done"><Icon name="check" /></span> : state === "failed" ? <span className="fail"><Icon name="x" /></span> : state === "skipped" ? <span className="skip"><Icon name="minus" /></span> : <span className="ring" />}
              </span>
              <div className="st">
                <b>{stepTitle(id)}</b>
                {stepNote(s) && <small>{stepNote(s)}</small>}
              </div>
              <div className="bs">
                {stepBadges(s).map((b) => (
                  <span key={b} className="badge mono">
                    {b}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {failure && !steps.some((s) => s.detail === failure) && <div className="cz-errbox cz-gap">{failure}</div>}
    </>
  );

  const oauthFound = probed?.auth?.oauth ?? null;
  // The sign-in service by its host, as people know it.
  const issuer = (oauthFound ? URL.parse(oauthFound.authorization_server)?.host || oauthFound.authorization_server : (d as { host?: string } | null)?.host) ?? "";
  const authChoices: Choice<Auth>[] = [
    { id: "oauth", label: t("addc.oauth"), tag: "OAuth", desc: t("addc.oauthDesc", { issuer }), off: !oauthFound?.pkce && t("addc.noOAuth") },
    { id: "token", label: t("addc.token"), desc: t("addc.tokenDesc") },
    { id: "none", label: t("addc.none"), desc: t("addc.noneDesc") },
  ];
  const ownRequired = probed?.suggested.client === "own";
  const clientChoices: Choice<Client>[] = [
    { id: "auto", label: t("addc.clientAuto"), desc: t("addc.clientAutoDesc"), off: ownRequired && t("addc.clientAutoOff", { issuer }) },
    { id: "own", label: t("addc.own"), desc: t("addc.ownDesc") },
  ];
  const transportChoices: Choice<"streamable_http" | "sse">[] = [
    { id: "streamable_http", label: "Streamable HTTP", desc: t("addc.httpDesc") },
    { id: "sse", label: t("addc.sse"), desc: t("addc.sseDesc") },
  ];
  // What the check found, then what adding does with the choice made.
  const found = !probed?.auth?.required
    ? t("addc.found.open")
    : oauthFound
      ? t(ownRequired ? "addc.found.oauthOwn" : "addc.found.oauth", { issuer })
      : t("addc.found.token");
  // Sentences run on without a space in Chinese, with one in English.
  const sep = t("addc.sep");
  const what = auth === "oauth" ? t("addc.oauthDesc", { issuer }) : auth === "token" ? t("addc.what.token") : null;
  const remoteView = (
    <>
      {summary(true)}
      {failure && <div className="cz-errbox cz-gap">{failure}</div>}
      <div className="cz-gh">{t("addc.auth")}</div>
      <div className="fgroup">
        <div className="frow">
          <span className="fl">{t("addc.method")}</span>
          <span className="fv">
            <PopUp label={t("addc.method")} value={auth} choices={authChoices} found={probed?.suggested.auth} onChange={setAuth} />
          </span>
        </div>
        {auth === "oauth" && client === "own" && (
          <>
            <div className="frow">
              <label className="fl" htmlFor="cz-client-id">Client ID</label>
              <span className="fv">
                <input id="cz-client-id" className="field mono" value={clientId} spellCheck={false} onChange={(e) => setClientId(e.target.value)} />
              </span>
            </div>
            <div className="frow">
              <label className="fl" htmlFor="cz-client-secret">Client Secret</label>
              <span className="fv">
                <input id="cz-client-secret" className="field mono" type="password" value={clientSecret} placeholder={t("addc.secretOptional")} onChange={(e) => setClientSecret(e.target.value)} />
              </span>
            </div>
          </>
        )}
        {auth === "token" && (
          <>
            <div className="frow">
              <label className="fl" htmlFor="cz-token">{t("addc.tokenRow")}</label>
              <span className="fv">
                <input id="cz-token" className="field mono" type="password" value={token} placeholder={t("addc.tokenPlaceholder")} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
              </span>
            </div>
            <div className="frow">
              <span className="fl">{t("addc.sendAs")}</span>
              {sendAs ? (
                <span className="fv cz-two">
                  <input className="field mono" value={header} placeholder="Header" aria-label="Header" onChange={(e) => setHeader(e.target.value)} />
                  <input className="field mono" value={prefix} placeholder={t("addc.prefix")} aria-label={t("addc.prefix")} onChange={(e) => setPrefix(e.target.value)} />
                </span>
              ) : (
                <span className="fv">
                  <code className="cz-code">{`${header}: ${prefix}‹${t("addc.tokenRow")}›`}</code>
                  <button className="link" onClick={() => setSendAs(true)}>
                    {t("addc.change")}
                  </button>
                </span>
              )}
            </div>
          </>
        )}
      </div>
      <p className="cz-fn">
        <span className="det">{found}</span>
        {/* When the person must bring their own app, what to do comes first; the rest is as usual. */}
        {what && !(auth === "oauth" && ownRequired) && sep + what}
        {auth === "oauth" && client === "own" && (
          <>
            {sep + t("addc.redirect", { issuer }) + " "}
            <code className="cz-code">http://127.0.0.1/callback</code>
            {t("addc.stop")}
          </>
        )}
        {auth === "oauth" && ownRequired && sep + t("addc.patHint")}
      </p>
      <button className={`cz-fold ${adv ? "open" : ""}`} aria-expanded={adv} onClick={() => setAdv(!adv)}>
        <Icon name="chevR" />
        {t("addc.advanced")}
        {!adv && <small>{t("addc.advancedNow", { transport: transport === "sse" ? t("addc.sse") : "Streamable HTTP", headers: headers.filter((h) => h.key.trim()).length || t("addc.noneShort") })}</small>}
      </button>
      {adv && (
        <div className="fgroup cz-advgroup">
          {/* Who finx signs in as: finx sees to it, unless the person must or wants to use their own app. */}
          {auth === "oauth" && (
            <div className="frow">
              <span className="fl">{t("addc.client")}</span>
              <span className="fv">
                <PopUp label={t("addc.client")} value={client} choices={clientChoices} onChange={setClient} />
              </span>
            </div>
          )}
          <div className="frow">
            <span className="fl">{t("addc.transport")}</span>
            <span className="fv">
              <PopUp label={t("addc.transport")} value={transport} choices={transportChoices} found={probed?.transport} onChange={setTransport} />
            </span>
          </div>
          <div className="frow stack">
            <span className="fl">{t("addc.headers")}</span>
            <Rows rows={headers} set={setHeaders} keyHint="Header" valueHint={t("addc.value")} />
          </div>
        </div>
      )}
      <p className="cz-trust">{t("addc.trust")}</p>
    </>
  );

  const argv = splitCommand(command);
  const localView = (
    <>
      {summary(true)}
      <div className="cz-gh">{t("addc.command")}</div>
      <div className="fgroup">
        <div className="frow stack">
          <input className="field mono" value={command} aria-label={t("addc.command")} spellCheck={false} onChange={(e) => setCommand(e.target.value)} />
          <div className="cz-cmdline">
            {argv.map((a, i) => (
              <span key={i} className={i === 0 ? "tok p" : "tok"}>
                {a}
              </span>
            ))}
          </div>
        </div>
      </div>
      {["npx", "uvx", "bunx", "pnpm", "docker"].includes(argv[0] ?? "") && <p className="cz-fn">{t("addc.download", { program: argv[0] })}</p>}
      <div className="cz-gh">{t("addc.env")}</div>
      <div className="fgroup">
        <div className="frow stack">
          <Rows rows={env} set={setEnv} keyHint={t("addc.varName")} valueHint={t("addc.value")} />
        </div>
      </div>
      <p className="cz-fn">{t("addc.envNote")}</p>
      <button className={`cz-fold ${ladv ? "open" : ""}`} aria-expanded={ladv} onClick={() => setLadv(!ladv)}>
        <Icon name="chevR" />
        {t("addc.advanced")}
        {!ladv && <small>{t("addc.cwdNow", { cwd: cwd || t("addc.default") })}</small>}
      </button>
      {ladv && (
        <div className="fgroup cz-advgroup">
          <div className="frow">
            <label className="fl" htmlFor="cz-cwd">{t("addc.cwd")}</label>
            <span className="fv">
              <input id="cz-cwd" className="field mono" value={cwd} placeholder={t("addc.cwdPlaceholder")} spellCheck={false} onChange={(e) => setCwd(e.target.value)} />
            </span>
          </div>
        </div>
      )}
      {failure && <div className="cz-errbox cz-gap">{failure}</div>}
      <p className="cz-trust">{t("addc.localTrust")}</p>
    </>
  );

  const loginView = (
    <div className="cz-center">
      <div className="big">
        <span className="mini-spin" />
      </div>
      <b>{t("addc.loginTitle", { name })}</b>
      <p>{t("addc.loginText", { issuer: oauthFound?.authorization_server ?? "" })}</p>
      {authorizeUrl && (
        <button className="link" data-authorize={authorizeUrl} onClick={() => void navigator.clipboard?.writeText(authorizeUrl)}>
          {t("addc.copyLink")}
        </button>
      )}
    </div>
  );

  const doneView = (
    <div className="cz-center">
      <div className="big ok">
        <Icon name="check" />
      </div>
      <b>{t("addc.added", { name })}</b>
      <p>{t("addc.addedText", { count: tools.length })}</p>
      <div className="cz-toolchips">
        {tools.slice(0, 6).map((tool) => (
          <span key={tool}>{tool}</span>
        ))}
        {tools.length > 6 && <span>{t("addc.more", { count: tools.length })}</span>}
      </div>
    </div>
  );

  const entryView = (
    <>
      <p className="sub">{t("addc.sub")}</p>
      <div className="cz-form">
        <div className="cz-fi">
          <label htmlFor="cz-add-name">{t("addc.name")}</label>
          <input
            id="cz-add-name"
            className={`field ${errors.name ? "bad" : ""}`}
            value={name}
            placeholder={suggested || t("addc.namePlaceholder")}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => (setName(e.target.value), setErrors({}))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void connect();
              // Tab takes the suggestion, as a completion does; with a name typed it moves on.
              if (e.key === "Tab" && !e.shiftKey && !name && suggested) {
                e.preventDefault();
                setName(suggested);
                setErrors({});
              }
            }}
          />
          {errors.name ? <div className="cz-ferr">{errors.name}</div> : <div className="note">{suggested ? t("addc.nameNoteSuggested", { name: suggested }) : t("addc.nameNote")}</div>}
        </div>
        <div className="cz-fi">
          <label htmlFor="cz-add-address">{t("addc.address")}</label>
          <textarea
            id="cz-add-address"
            rows={1}
            className={`field mono cz-grow ${errors.address ? "bad" : ""}`}
            value={address}
            placeholder={t("addc.addressPlaceholder")}
            spellCheck={false}
            autoFocus
            onChange={(e) => {
              setAddress(e.target.value);
              setErrors({});
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight + 2}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void connect();
              }
            }}
          />
          {errors.address ? <div className="cz-ferr">{errors.address}</div> : hint}
        </div>
      </div>
    </>
  );

  const okToAdd =
    step === "local" ? argv.length > 0 : auth === "token" ? !!token.trim() || headers.some((h) => h.value) : auth === "oauth" && client === "own" ? !!clientId.trim() : true;
  const foot =
    step === "entry" ? (
      <>
        <div className="left">
          <span className="note">{t("addc.jsonHint")}</span>
        </div>
        <button className="btn" onClick={close}>
          {t("addc.cancel")}
        </button>
        <button className="btn primary" disabled={!detected || detected.kind === "bad" || !!duplicate} onClick={() => void connect()}>
          {t("addc.connect")}
        </button>
      </>
    ) : step === "check" ? (
      failure ? (
        <>
          <div className="left">
            <button className="link" disabled={busy} onClick={() => void addAnyway()}>
              {t("addc.addAnyway")}
            </button>
          </div>
          <button className="btn" onClick={edit}>
            {t("addc.edit")}
          </button>
          <button className="btn primary" onClick={retry}>
            {t("addc.retry")}
          </button>
        </>
      ) : (
        <>
          <button className="btn" onClick={close}>
            {t("addc.cancel")}
          </button>
          <button className="btn primary" disabled>
            <span className="mini-spin cz-spin-solid" />
          </button>
        </>
      )
    ) : step === "login" ? (
      <button className="btn" onClick={() => (loginWait.current?.(), setStep("remote"))}>
        {t("addc.cancel")}
      </button>
    ) : step === "done" ? (
      <button className="btn primary" onClick={onClose}>
        {t("addc.finish")}
      </button>
    ) : (
      <>
        <button className="btn" onClick={edit}>
          {t("addc.back")}
        </button>
        <button className="btn primary" disabled={busy || !okToAdd} onClick={() => void add(step)}>
          {busy && <span className="mini-spin cz-spin-solid" />}
          {step === "remote" && auth === "oauth" ? t("addc.addAndLogin") : t("addc.add")}
        </button>
      </>
    );

  const title = step === "local" ? t("addc.titleLocal") : t("addc.title");
  return (
    <Dialog label={title} width={520} className="cz-sheet cz-add" onClose={close}>
      <h3>{title}</h3>
      <div className="cz-add-body" data-step={step}>
        {step === "entry" ? entryView : step === "check" ? checkView : step === "remote" ? remoteView : step === "local" ? localView : step === "login" ? loginView : doneView}
      </div>
      <div className="sheet-foot">{foot}</div>
    </Dialog>
  );
}
