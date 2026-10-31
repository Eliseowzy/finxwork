import type { TFunction } from "i18next";
import type { ConfigLayer, McpServerView, SkillEntry, SkillsListResult } from "@finx/protocol";
import { catalogConnectors, catalogSkills, type CatalogConnector, type CatalogSkill } from "../../../shared/catalog";

// What the 自定义 page shows, made from finx's answers (skills/list, mcp/list, config/read):
// the groups of 我的, which catalog entries are added, and each server's state as one line
// (customize-design §8.1, §10.5). No text here: the page words it.

/** Where a skill lives, as 我的 groups them. */
export type SkillGroup = "user" | "project" | "extra" | "system";

export type SkillItem = {
  entry: SkillEntry;
  /** The skill's folder. */
  dir: string;
  group: SkillGroup;
  on: boolean;
  /** Off until turned on: a skill in the repository's `.claude/skills` (skill-design D-173). */
  offByDefault: boolean;
  /** The other app's folder it lives in (".claude"): the home's, read with `skills.other_apps`, or the repository's. */
  from: string | null;
  /** The catalog entry it was added from. */
  catalog: CatalogSkill | null;
};

/** An entry's text in the locale files (customize.catalog.<kind>.<id>): the keys come and go with the catalog. */
export function catalogText(t: TFunction<"customize">, key: string, options?: Record<string, unknown>): string {
  return String(t(key as never, options as never));
}

export function skillDir(path: string): string {
  return path.replace(/[/\\]SKILL\.md$/i, "");
}

/** `.claude` for `…/.claude/skills/x/SKILL.md`. */
function clientFolder(path: string): string | null {
  const m = /[/\\](\.[^/\\]+)[/\\]skills[/\\]/.exec(path);
  return m ? m[1] : null;
}

/** The skills of 我的: every one a session here would find, those turned off included; broken ones are listed apart. */
export function skillItems(list: SkillsListResult | null): SkillItem[] {
  if (!list) return [];
  return list.skills
    .filter((e) => e.state !== "invalid" && e.state !== "shadowed")
    .map((entry) => ({
      entry,
      dir: skillDir(entry.path),
      group: entry.scope,
      on: entry.state !== "disabled",
      offByDefault: entry.default_enabled === false,
      from: (entry.scope === "user" && !entry.removable) || entry.default_enabled === false ? clientFolder(entry.path) : null,
      catalog: catalogSkills.find((c) => (entry.source?.kind === "catalog" ? entry.source.id === c.id : entry.name === c.id)) ?? null,
    }));
}

/** Skills that did not load, with why. */
export function brokenSkills(list: SkillsListResult | null): SkillEntry[] {
  return list?.skills.filter((e) => e.state === "invalid") ?? [];
}

/** The copy of the same name that takes over when `item` is turned off. */
export function nextInLine(list: SkillsListResult | null, item: SkillItem): SkillEntry | null {
  return list?.skills.find((e) => e.state === "shadowed" && e.name === item.entry.name && e.detail === item.entry.path) ?? null;
}

/** A catalog skill is added when one of the person's skills came from it, or has its name. */
export function addedSkill(items: SkillItem[], c: CatalogSkill): SkillItem | null {
  return items.find((i) => i.catalog?.id === c.id) ?? null;
}

/** Where a server is defined, as 我的 groups them: the repository's two files go together. */
export type ConnectorGroup = "user" | "user_project" | "project" | "flag";

export function connectorGroup(layer: ConfigLayer): ConnectorGroup {
  return layer === "project_json" ? "project" : layer;
}

/** A catalog connector is added when a server has its name: another would only clash. */
export function addedConnector(servers: McpServerView[], c: CatalogConnector): McpServerView | null {
  return servers.find((s) => s.name === c.id) ?? null;
}

export function catalogOf(server: McpServerView): CatalogConnector | null {
  return catalogConnectors.find((c) => c.id === server.name) ?? null;
}

/** A server of the repository: read-only here, turned off for the person alone. */
export function fromRepo(s: McpServerView): boolean {
  return s.layer === "project" || s.layer === "project_json";
}

/** The two letters on a server's tile. */
export function monogram(name: string): string {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

/** A server's state as a row shows it (§8.1): off, being checked, then finx's. */
export type StatusLook =
  | { kind: "off"; forYou: boolean }
  | { kind: "checking" }
  | { kind: "ok"; tools: number; sessions: number | null; checkedAt: string | null }
  | { kind: "failed"; error: string | null }
  | { kind: "needs_login" }
  | { kind: "unknown" }
  | { kind: "untrusted" };

export function statusOf(s: McpServerView, checking: boolean): StatusLook {
  if (s.status.state === "untrusted") return { kind: "untrusted" };
  if (!s.enabled) return { kind: "off", forYou: fromRepo(s) && s.disabled_by === "user_project" };
  if (checking) return { kind: "checking" };
  switch (s.status.state) {
    case "ok":
      return { kind: "ok", tools: s.status.tools ?? 0, sessions: s.status.source === "session" ? (s.status.sessions ?? null) : null, checkedAt: s.status.checked_at ?? null };
    case "failed":
      return { kind: "failed", error: s.status.error ?? null };
    case "needs_login":
      return { kind: "needs_login" };
    default:
      return { kind: "unknown" };
  }
}

/** A command line as the form shows it, quoting arguments with spaces. */
export function joinCommand(command: string, args: string[]): string {
  return [command, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/** The words of a command line: spaces separate them, quotes keep them together. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let word = "";
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(word);
      word = "";
      started = false;
    } else {
      word += c === "\\" && i + 1 < line.length ? line[++i] : c;
      started = true;
    }
  }
  if (started) out.push(word);
  return out;
}

/** A server name finx accepts. */
export const serverName = /^[A-Za-z0-9_-]{1,32}$/;

/** The credential a locked value of a server is kept under. */
export function credentialName(server: string, key: string): string {
  return `mcp.${server}.${key.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** The credential a value refers to: `Bearer ${credential:name}` → name. */
export function credentialRef(value: string): string | null {
  const m = /\$\{credential:([^}]+)\}/.exec(value);
  return m ? m[1] : null;
}

/** The value written for a secret now kept as `name`: the old value's words around its reference stay ("Bearer "). */
export function withCredential(old: string | null, name: string): string {
  const ref = `\${credential:${name}}`;
  return old && credentialRef(old) ? old.replace(/\$\{credential:[^}]+\}/, ref) : ref;
}

/** What adding a catalog connector writes, and the secret to keep for it (§10.4). */
export function catalogServer(c: CatalogConnector, token: string | null): { server: Record<string, unknown>; secrets: [string, string][] } {
  const auth = c.install.auth;
  const secrets: [string, string][] = [];
  const secret = (key: string, prefix = "") => {
    const name = credentialName(c.id, key);
    if (token) secrets.push([name, token]);
    return `${prefix}\${credential:${name}}`;
  };
  if ("url" in c.install) {
    const server: Record<string, unknown> = { url: c.install.url };
    if (auth.kind === "token" && auth.header) server.headers = { [auth.header]: secret(auth.header, auth.prefix) };
    return { server, secrets };
  }
  const server: Record<string, unknown> = { command: c.install.command, args: c.install.args };
  if (auth.kind === "token" && auth.env) server.env = { [auth.env]: secret(auth.env) };
  return { server, secrets };
}
