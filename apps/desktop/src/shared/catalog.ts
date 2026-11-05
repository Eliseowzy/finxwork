// What the 自定义 page's 发现 view offers (docs/desktop/customize-design.md §10.6): skills
// whose files ship with the app (resources/catalog/skills/<id>), and MCP servers to add with
// one click. Emptied on 2026-10-31, to be filled again entry by entry. Plain data; the page's text about each lives in the locale files
// (customize.catalog.<id>). A connector is listed only after its address, transport and
// authentication were checked against the provider's documentation and it connected.

export type CatalogSkill = {
  id: string;
  by: string;
  version: string;
  license: string;
  /** Of the skill's files, as finx records an install (scripts/catalog-hash.mjs): the build checks it. */
  sha256: string;
  files: number;
};

/** A secret the server needs: kept in the keychain, the configuration refers to it. */
export type TokenAuth = {
  kind: "token";
  /** Sent as this header, after `prefix`; or else given to the command as `env`. */
  header?: string;
  prefix?: string;
  env?: string;
  placeholder: string;
  /** Where to get one. */
  createURL: string;
};

/** Signing in with an account (OAuth), at `url` when that is not the usual address. */
export type OAuthAuth = { kind: "oauth"; url?: string };

export type ConnectorAuth = { kind: "none" } | OAuthAuth | TokenAuth;

export type CatalogConnector = {
  /** A curated CLI manifest owned by finx; installation never takes a renderer-supplied command. */
  managed?: string;
  /** Also the server's name in the configuration. */
  id: string;
  name: string;
  /** The tile's letters, when there is no logo. */
  mono: string;
  /** The provider's logo, a file in src/renderer/src/assets/connectors. */
  logo?: string;
  by: string;
  docs: string;
  /** When the entry was last checked against the provider. */
  verifiedAt: string;
  /**
   * `auth`: every way the provider accepts, the recommended one first. The person picks one
   * when adding; only an entry that needs nothing is added with one click.
   */
  install: { url: string; auth: ConnectorAuth[] } | { command: string; args: string[]; auth: ConnectorAuth[] };
};

export const catalogSkills: CatalogSkill[] = [];

export const catalogConnectors: CatalogConnector[] = [
  {
    id: "dingtalk", name: "钉钉", mono: "钉", logo: "dingtalk.png", by: "钉钉", managed: "dingtalk",
    docs: "https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli",
    verifiedAt: "2026-11-02",
    install: { command: "dws", args: [], auth: [{ kind: "oauth" }] },
  },
  {
    id: "feishu", name: "飞书", mono: "飞", logo: "feishu.png", by: "飞书", managed: "feishu",
    docs: "https://github.com/larksuite/cli", verifiedAt: "2026-11-03",
    install: { command: "lark-cli", args: [], auth: [{ kind: "oauth" }] },
  },
  {
    id: "wecom", name: "企业微信", mono: "企", logo: "wecom.png", by: "企业微信", managed: "wecom",
    docs: "https://github.com/WecomTeam/wecom-cli", verifiedAt: "2026-11-03",
    install: { command: "wecom-cli", args: [], auth: [{ kind: "oauth" }] },
  },
];

/** Whether the entry needs nothing from the person, so it can be added with one click. */
export function oneClick(c: CatalogConnector): boolean {
  return c.install.auth.every((a) => a.kind === "none");
}

/** The command line a stdio entry runs, as the page shows it. */
export function commandLine(c: CatalogConnector): string | null {
  return "command" in c.install ? [c.install.command, ...c.install.args].join(" ") : null;
}
