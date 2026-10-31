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

export type ConnectorAuth = { kind: "none" } | TokenAuth;

export type CatalogConnector = {
  /** Also the server's name in the configuration. */
  id: string;
  name: string;
  /** The tile's letters (no logos yet). */
  mono: string;
  by: string;
  docs: string;
  /** When the entry was last checked against the provider. */
  verifiedAt: string;
  install: { url: string; auth: ConnectorAuth } | { command: string; args: string[]; auth: ConnectorAuth };
};

export const catalogSkills: CatalogSkill[] = [];

export const catalogConnectors: CatalogConnector[] = [];

/** The command line a stdio entry runs, as the page shows it. */
export function commandLine(c: CatalogConnector): string | null {
  return "command" in c.install ? [c.install.command, ...c.install.args].join(" ") : null;
}
