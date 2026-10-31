import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { RpcError } from "@finx/client";
import type { ConfigLayer, McpServerView } from "@finx/protocol";
import { localIdentity, remoteIdentity } from "../../../shared/identity";
import { Dialog } from "../components";
import { Icon } from "../icons";
import { errorText, useStore } from "../store";
import { credentialName, credentialRef, joinCommand, serverName, splitCommand, withCredential } from "./model";
import { tilde } from "./parts";
import type { Customize } from "./useCustomize";

// 添加 › 自定义连接器, and 编辑配置 (customize-design §10.4): a command or an address, rows of
// variables or headers whose locked values go to the keychain (credentials/set) while the
// file gets a reference, and where it is written. finx checks it before writing.

/** One key/value row; `saved` is the value in the file when it refers to a saved secret. */
type Row = { key: string; value: string; locked: boolean; saved: string | null };

const secretish = /token|key|secret|password|passwd|auth|cookie|credential/i;

function rowsOf(map: unknown): Row[] {
  if (!map || typeof map !== "object") return [];
  return Object.entries(map as Record<string, unknown>).map(([key, v]) => {
    const value = String(v ?? "");
    return credentialRef(value) ? { key, value: "", locked: true, saved: value } : { key, value, locked: false, saved: null };
  });
}

const blank = (key = "", locked = false): Row => ({ key, value: "", locked, saved: null });

type Errors = { name?: string; command?: string; url?: string; other?: string };

/** A server's settings as a .mcp.json entry or a finx table, and its name when the JSON has one. */
function parsePasted(text: string): { name?: string; server: Record<string, unknown> } | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const isServer = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && ("command" in x || "url" in x || "serverUrl" in x);
  if (isServer(v)) return { server: v };
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const table = (o.mcpServers ?? o.mcp_servers ?? o.servers ?? o) as Record<string, unknown>;
  const first = Object.entries(table ?? {}).find(([, s]) => isServer(s));
  return first ? { name: first[0], server: first[1] as Record<string, unknown> } : null;
}

export function ConnectorForm({ c, edit, project, onClose, onSaved }: { c: Customize; edit: McpServerView | null; project: string | null; onClose: () => void; onSaved: (name: string) => void }) {
  const { t } = useTranslation("customize");
  const st = useStore();
  // What the files say about the server, references kept (config/read).
  const raw = (edit ? ((c.config?.config as { mcp_servers?: Record<string, Record<string, unknown>> })?.mcp_servers?.[edit.name] ?? {}) : {}) as Record<string, unknown>;
  const [name, setName] = useState(edit?.name ?? "");
  const [kind, setKind] = useState<"stdio" | "http">(edit?.transport === "stdio" || !edit ? "stdio" : "http");
  const [command, setCommand] = useState(typeof raw.command === "string" ? joinCommand(raw.command, Array.isArray(raw.args) ? raw.args.map(String) : []) : "");
  const [url, setUrl] = useState(typeof raw.url === "string" ? raw.url : "");
  const [env, setEnv] = useState<Row[]>(() => {
    const rows = rowsOf(raw.env);
    return rows.length ? rows : [blank()];
  });
  const [headers, setHeaders] = useState<Row[]>(() => {
    const rows = rowsOf(raw.headers);
    return rows.length ? rows : [blank("Authorization", true)];
  });
  // An edit stays in the layer it came from; a new connector goes to the user's own config.
  const layer: ConfigLayer = edit && (edit.layer === "user" || edit.layer === "user_project") ? edit.layer : "user";
  const [errors, setErrors] = useState<Errors>({});
  const [pasting, setPasting] = useState(false);
  const [pasteBad, setPasteBad] = useState(false);
  const [busy, setBusy] = useState(false);

  const fill = (text: string) => {
    const found = parsePasted(text);
    setPasteBad(!found && text.trim() !== "");
    if (!found) return;
    const s = found.server;
    if (found.name && !edit) setName(found.name);
    const remote = typeof s.url === "string" || typeof s.serverUrl === "string";
    setKind(remote ? "http" : "stdio");
    if (remote) setUrl(String(s.url ?? s.serverUrl));
    else setCommand(joinCommand(String(s.command), Array.isArray(s.args) ? s.args.map(String) : []));
    const lockable = (rows: Row[]) => rows.map((r) => (r.saved ? r : { ...r, locked: secretish.test(r.key) }));
    if (s.env) setEnv(lockable(rowsOf(s.env)));
    if (s.headers) setHeaders(lockable(rowsOf(s.headers)));
    setPasting(false);
  };

  const save = async () => {
    const e: Errors = {};
    const n = edit?.name ?? name.trim();
    if (!edit) {
      const taken = c.servers.find((s) => s.name === n);
      if (!n) e.name = t("form.errName");
      else if (!serverName.test(n)) e.name = t("form.errNameChars");
      else if (taken) e.name = t("form.errNameTaken", { name: n, file: taken.file ? tilde(taken.file) : taken.layer });
    }
    const words = splitCommand(command);
    if (kind === "stdio" && words.length === 0) e.command = t("form.errCommand");
    if (kind === "http" && !url.trim()) e.url = t("form.errUrl");
    else if (kind === "http" && !/^https?:\/\//.test(url.trim())) e.url = t("form.errUrlScheme");
    // One service, one connector (mcp-design §13.10).
    const id = kind === "http" ? remoteIdentity(url) : words.length ? localIdentity(words[0], words.slice(1)) : null;
    // Only a change of address counts: entries that were alike already can still be edited.
    const same = id && id !== edit?.identity && c.servers.find((s) => s.identity === id && s.name !== edit?.name);
    if (same) e[kind === "http" ? "url" : "command"] = t("addc.duplicate", { name: same.name });
    setErrors(e);
    if (Object.keys(e).length) return;
    // Locked values with something typed go to the keychain; saved ones stay as they are.
    const secrets: [string, string][] = [];
    const table = (rows: Row[]) => {
      const out: Record<string, string> = {};
      for (const r of rows) {
        const key = r.key.trim();
        if (!key) continue;
        if (r.value === "" && r.saved) out[key] = r.saved;
        else if (r.value === "") continue;
        else if (r.locked) {
          const credential = credentialName(n, key);
          secrets.push([credential, r.value]);
          out[key] = withCredential(r.saved, credential);
        } else out[key] = r.value;
      }
      return Object.keys(out).length ? out : null;
    };
    const fields: Record<string, unknown> =
      kind === "stdio"
        ? { command: words[0], args: words.length > 1 ? words.slice(1) : null, env: table(env), url: null, headers: null }
        : { url: url.trim(), headers: table(headers), command: null, args: null, env: null };
    // An edit changes these fields only; a new connector is written whole.
    const merge = edit ? "upsert" : "replace";
    const server = merge === "upsert" ? fields : Object.fromEntries(Object.entries({ ...raw, enabled: undefined, ...fields }).filter(([, v]) => v !== null && v !== undefined));
    setBusy(true);
    try {
      const { written, check } = await c.saveServer(layer, n, server, secrets, undefined, merge);
      onSaved(n);
      onClose();
      const where = tilde(written.file);
      if (edit) st.show(t("toast.serverSaved", { name: n }));
      else if (check?.server.status.state === "ok") st.show(t("toast.serverAdded", { name: n, count: check.tools.length }));
      else if (check?.server.status.state === "failed") st.show(t("toast.serverAddedFailed", { name: n, error: check.server.status.error ?? "" }), undefined, true);
      else st.show(t("toast.serverAddedFile", { name: n, file: where }));
    } catch (err) {
      // finx's checks, by field (config_validation_error carries the key paths).
      const found = err instanceof RpcError && err.kind === "config_validation_error" ? ((err.data as { errors?: { key_path: string; message: string }[] })?.errors ?? []) : [];
      if (found.length) {
        const next: Errors = {};
        for (const f of found) {
          if (/\.(command|args)$/.test(f.key_path)) next.command = f.message;
          else if (/\.url$/.test(f.key_path)) next.url = f.message;
          else next.other = f.message;
        }
        setErrors(next);
      } else setErrors({ other: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const rowsField = (rows: Row[], set: (rows: Row[]) => void) => (
    <div className="cz-kvs">
      {rows.map((r, i) => {
        const update = (patch: Partial<Row>) => set(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={i} className="cz-kvrow">
            <input className="field mono" placeholder="KEY" value={r.key} spellCheck={false} onChange={(e) => update({ key: e.target.value })} />
            <input
              className={`field mono ${r.saved ? "saved" : ""}`}
              type={r.locked ? "password" : "text"}
              placeholder={r.saved && r.value === "" ? t("form.savedPlaceholder") : "value"}
              value={r.value}
              spellCheck={false}
              onChange={(e) => update({ value: e.target.value })}
            />
            <button className={`cz-lock ${r.locked ? "on" : ""}`} title={r.locked ? t("form.lockOn") : t("form.lockOff")} aria-pressed={r.locked} aria-label={t("form.lockOn")} onClick={() => update({ locked: !r.locked })}>
              <Icon name={r.locked ? "lock" : "unlock"} />
            </button>
            <button className="cz-lock" title={t("form.dropRow")} aria-label={t("form.dropRow")} onClick={() => set(rows.length > 1 ? rows.filter((_, j) => j !== i) : [blank()])}>
              <Icon name="x" />
            </button>
          </div>
        );
      })}
      <button className="link cz-addrow" onClick={() => set([...rows, blank()])}>
        <Icon name="plus" />
        {t("form.addRow")}
      </button>
    </div>
  );

  return (
    <Dialog label={edit ? t("form.editTitle", { name: edit.name }) : t("form.addTitle")} width={540} className="cz-sheet" onClose={onClose}>
      <h3>{edit ? t("form.editTitle", { name: edit.name }) : t("form.addTitle")}</h3>
      <p className="sub">{t("form.sub")}</p>
      {pasting && (
        <div className="cz-fi cz-paste">
          <textarea className="field mono" autoFocus rows={5} placeholder={t("form.pastePlaceholder")} onChange={(e) => fill(e.target.value)} />
          {pasteBad && <div className="cz-ferr">{t("form.pasteBad")}</div>}
        </div>
      )}
      <div className="cz-form">
        <div className="cz-fi">
          <label>{t("form.name")}</label>
          <input className={`field ${errors.name ? "bad" : ""}`} autoFocus={!edit} disabled={!!edit} placeholder={t("form.namePlaceholder")} value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
          {errors.name && <div className="cz-ferr">{errors.name}</div>}
          <span className="note">{t("form.nameNote")}</span>
        </div>
        <div className="cz-fi">
          <label>{t("form.kind")}</label>
          <div className="seg cz-segsm">
            <button className={kind === "stdio" ? "on" : ""} onClick={() => setKind("stdio")}>
              <Icon name="terminal" className="sm" />
              {t("form.stdio")}
            </button>
            <button className={kind === "http" ? "on" : ""} onClick={() => setKind("http")}>
              <Icon name="globe" className="sm" />
              {t("form.http")}
            </button>
          </div>
        </div>
        {kind === "stdio" ? (
          <>
            <div className="cz-fi">
              <label>{t("form.command")}</label>
              <input className={`field mono ${errors.command ? "bad" : ""}`} placeholder={t("form.commandPlaceholder")} value={command} spellCheck={false} onChange={(e) => setCommand(e.target.value)} />
              {errors.command && <div className="cz-ferr">{errors.command}</div>}
            </div>
            <div className="cz-fi">
              <label>
                {t("form.env")} <em>{t("form.optional")}</em>
              </label>
              {rowsField(env, setEnv)}
            </div>
          </>
        ) : (
          <>
            <div className="cz-fi">
              <label>{t("form.url")}</label>
              <input className={`field mono ${errors.url ? "bad" : ""}`} placeholder={t("form.urlPlaceholder")} value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
              {errors.url && <div className="cz-ferr">{errors.url}</div>}
            </div>
            <div className="cz-fi">
              <label>
                {t("form.headers")} <em>{t("form.optional")}</em>
              </label>
              {rowsField(headers, setHeaders)}
              <span className="note">{t("form.tokenNote")}</span>
            </div>
          </>
        )}
        <div className="cz-callout">
          <Icon name="lock" />
          <span>
            <Trans t={t} i18nKey="form.lockNote" components={{ code: <code /> }} />
          </span>
        </div>
        {errors.other && <div className="cz-errbox">{errors.other}</div>}
      </div>
      <div className="sheet-foot">
        <div className="left">
          <button className="link" onClick={() => (setPasting(!pasting), setPasteBad(false))}>
            {t("form.paste")}
          </button>
        </div>
        <button className="btn" onClick={onClose}>
          {t("form.cancel")}
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy && <span className="mini-spin cz-spin-solid" />}
          {edit ? t("form.save") : t("form.add")}
        </button>
      </div>
    </Dialog>
  );
}
