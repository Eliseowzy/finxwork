import { useEffect, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { ConfigLayer, McpServerView, McpToolsResult, SkillsFilesResult } from "@finx/protocol";
import { catalogConnectors, catalogSkills, commandLine, type CatalogConnector } from "../../../shared/catalog";
import { agoText } from "../format";
import { Icon } from "../icons";
import { errorText, useNow, useStore, type CustomizeView } from "../store";
import { serverMenu, skillMenu, type Actions } from "./Lists";
import { addedConnector, addedSkill, catalogOf, catalogText, connectorGroup, fromRepo, statusOf, type SkillItem } from "./model";
import { MoreButton, ServerTile, SkillTile, Status, Switch, tilde, useStatusSource } from "./parts";
import type { Customize } from "./useCustomize";

// A card's own page (customize-design §10.1): back to the list, the item with its actions,
// tabs on a hairline, then what it does on the left and the facts about it on the right.

type Detail = NonNullable<CustomizeView["detail"]>;

/** Where the catalog's skill files are. */
export function catalogDir(): string {
  return window.finx?.catalogDir || "/catalog/skills";
}

function Back({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button className="cz-back" onClick={onBack}>
      <Icon name="arrowLeft" />
      {label}
    </button>
  );
}

function Hero({ tile, name, badge, meta, acts }: { tile: ReactNode; name: string; badge?: ReactNode; meta: ReactNode[]; acts: ReactNode }) {
  return (
    <div className="cz-hero">
      {tile}
      <div className="dt">
        <h1>
          {name}
          {badge}
        </h1>
        <div className="cz-meta">
          {meta.map((m, i) => (
            <span key={i} className="cz-meta-i">
              {i > 0 && <i>·</i>}
              {m}
            </span>
          ))}
        </div>
      </div>
      <div className="cz-acts">{acts}</div>
    </div>
  );
}

function Tabs({ tabs, on, onTab }: { tabs: { id: string; label: string; n?: number }[]; on: string; onTab: (id: string) => void }) {
  return (
    <div className="cz-dtabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" aria-selected={on === tab.id} className={`cz-dtab ${on === tab.id ? "on" : ""}`} onClick={() => onTab(tab.id)}>
          {tab.label}
          {tab.n !== undefined && <span className="n"> · {tab.n}</span>}
        </button>
      ))}
    </div>
  );
}

function Fact({ k, children, stack, mono }: { k: string; children: ReactNode; stack?: boolean; mono?: boolean }) {
  return (
    <div className={`cz-kv ${stack ? "stack" : ""}`}>
      <span className="k">{k}</span>
      <span className={`v ${mono ? "mono" : ""}`}>{children}</span>
    </div>
  );
}

function Callout({ icon = "info", warn, children, action }: { icon?: string; warn?: boolean; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`cz-callout ${warn ? "warn" : ""}`}>
      <Icon name={icon} />
      <span>{children}</span>
      {action}
    </div>
  );
}

function SolidAdd({ busy, label, busyLabel, onAdd }: { busy: boolean; label: string; busyLabel: string; onAdd: () => void }) {
  return busy ? (
    <button className="btn cz-solid" disabled>
      <span className="mini-spin cz-spin-solid" />
      {busyLabel}
    </button>
  ) : (
    <button className="btn cz-solid" onClick={onAdd}>
      <Icon name="plus" />
      {label}
    </button>
  );
}

/** The text of a SKILL.md, its header set apart. */
function SkillMd({ text }: { text: string }) {
  const m = /^(---\r?\n[\s\S]*?\r?\n---)(\r?\n|$)/.exec(text);
  return (
    <pre className="cz-code">
      {m ? (
        <>
          <span className="fm">{m[1]}</span>
          {text.slice(m[1].length)}
        </>
      ) : (
        text
      )}
    </pre>
  );
}

function sizeText(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function SkillPage({ c, a, detail, project, onBack, onTab }: { c: Customize; a: Actions; detail: Detail; project: string | null; onBack: () => void; onTab: (tab: string) => void }) {
  const { t } = useTranslation("customize");
  const st = useStore();
  const item: SkillItem | null = detail.catalog ? null : (c.items.find((i) => i.dir === detail.id) ?? null);
  const cat = detail.catalog ? (catalogSkills.find((x) => x.id === detail.id) ?? null) : (item?.catalog ?? null);
  const installed = detail.catalog && cat ? addedSkill(c.items, cat) : null;
  const dir = item?.dir ?? (cat ? `${catalogDir()}/${cat.id}` : null);
  const [files, setFiles] = useState<SkillsFilesResult | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  useEffect(() => {
    if (!dir || !st.rpc) return;
    let current = true;
    st.rpc.request("skills/files", { path: dir }).then(
      (f) => current && (setFiles(f), setFilesError(null)),
      (e) => current && setFilesError(errorText(e)),
    );
    return () => {
      current = false;
    };
  }, [dir, st.rpc]);
  // Added from its page: the page of the skill it became.
  useEffect(() => {
    if (installed) a.open({ kind: "skill", id: installed.dir, tab: detail.tab });
  }, [installed, a, detail.tab]);
  // Gone (removed elsewhere): back to the list.
  const gone = c.loaded && !item && !cat;
  useEffect(() => {
    if (gone) onBack();
  }, [gone, onBack]);
  if (!item && !cat) return null;
  const name = item?.entry.name ?? cat!.id;
  const count = files ? files.files.filter((f) => !f.dir).length : (cat?.files ?? 0);
  const description = item?.entry.description ?? catalogText(t, `catalog.skills.${cat!.id}`);
  const scope = item ? t(`skill.scope.${item.group}`, { project }) : null;
  const meta = item ? [scope, t("skill.files", { count })] : [t("catalog.by"), t("skill.files", { count })];
  if (item && !item.on) meta.push(t("skill.off"));
  const acts = item ? (
    <>
      {item.on && (
        <button className="btn" onClick={() => a.useSkill(item.entry.name)}>
          <Icon name="chat" />
          {t("skill.use")}
        </button>
      )}
      <MoreButton label={t("more")} items={() => skillMenu(item, a, c, t, false)} />
    </>
  ) : (
    <SolidAdd busy={c.adding.has(`skill:${cat!.id}`)} label={t("skill.add")} busyLabel={t("skill.adding")} onAdd={() => a.installSkill(cat!)} />
  );
  const source = item
    ? item.group === "system"
      ? t("skill.source.system")
      : item.from
        ? t(item.group === "project" ? "skill.fromApp" : "skill.sharedWith", { from: item.from })
        : item.group === "project"
          ? t("skill.source.repo")
          : item.group === "extra"
            ? t("skill.source.extra")
            : t(`skill.source.${item.entry.source?.kind ?? "local"}` as "skill.source.local")
    : t("catalog.by");
  let main: ReactNode;
  if (detail.tab === "skillmd") {
    main = (
      <div className="cz-pane">
        <div className="cz-filebar">
          <Icon name="file" />
          <span className="mono">{tilde(`${dir}/SKILL.md`)}</span>
          {item && (
            <button className="link" onClick={() => window.finx?.revealPath(`${dir}/SKILL.md`)}>
              {t("skill.reveal")}
            </button>
          )}
        </div>
        {files ? <SkillMd text={files.skill_md} /> : <div className="cz-wait">{filesError ? t("skill.noFiles", { error: filesError }) : t("loading")}</div>}
      </div>
    );
  } else if (detail.tab === "files") {
    main = (
      <div className="cz-pane">
        {files ? (
          <div className="fgroup cz-files">
            {files.files.map((f) => (
              <div key={f.path} className="frow">
                <Icon name={f.dir ? "folder" : "file"} />
                <span className="mono">{f.path}</span>
                {!f.dir && <span className="sz">{sizeText(f.size)}</span>}
              </div>
            ))}
          </div>
        ) : (
          <div className="cz-wait">{filesError ? t("skill.noFiles", { error: filesError }) : t("loading")}</div>
        )}
      </div>
    );
  } else {
    const note =
      item?.group === "system" ? (
        <Callout>{t("skill.systemNote")}</Callout>
      ) : item?.offByDefault ? (
        <Callout>
          <Trans t={t} i18nKey="skill.offByDefaultNote" values={{ folder: `${item.from ?? ".claude"}/skills` }} components={{ code: <code /> }} />
        </Callout>
      ) : item?.group === "project" ? (
        <Callout>{t("skill.repoNote")}</Callout>
      ) : item?.from ? (
        <Callout>
          <Trans t={t} i18nKey="skill.sharedNote" values={{ folder: `~/${item.from}/skills` }} components={{ code: <code /> }} />
        </Callout>
      ) : item?.group === "extra" ? (
        <Callout>{t("skill.extraNote")}</Callout>
      ) : null;
    main = (
      <div className="cz-cols">
        <div>
          <div className="cz-dsec">
            <h4>{t("skill.description")}</h4>
            <p>{description}</p>
          </div>
          <div className="cz-dsec">
            <h4>{t("skill.howTo")}</h4>
            <p>
              <Trans t={t} i18nKey={item && !item.entry.model_invocable ? "skill.howToUserOnly" : "skill.howToText"} values={{ name }} components={{ code: <code /> }} />
            </p>
          </div>
          {note && <div className="cz-dsec">{note}</div>}
        </div>
        <aside className="cz-side">
          {item && (
            <Fact k={t("skill.enabled")}>
              <Switch on={item.on} label={item.on ? t("skill.turnOff") : t("skill.turnOn")} onChange={(on) => a.toggleSkill(item, on)} />
            </Fact>
          )}
          <Fact k={t("skill.sourceLabel")}>{source}</Fact>
          {item ? (
            <>
              <Fact k={t("skill.scopeLabel")}>{scope}</Fact>
              <Fact k={t("skill.path")} stack mono>
                {tilde(item.dir)}
              </Fact>
            </>
          ) : (
            <>
              <Fact k={t("skill.license")}>{cat!.license === "finxwork" ? t("skill.licenseFinxwork") : cat!.license}</Fact>
              <Fact k={t("skill.addTo")} stack mono>
                {t("skill.addToValue", { path: `~/.finx/skills/${cat!.id}` })}
              </Fact>
            </>
          )}
        </aside>
      </div>
    );
  }
  return (
    <>
      <Back label={t("skill.back")} onBack={onBack} />
      <Hero tile={<SkillTile size="xl" />} name={name} badge={item?.group === "system" && <span className="badge">{t("skill.builtIn")}</span>} meta={meta} acts={acts} />
      <Tabs
        tabs={[
          { id: "overview", label: t("skill.tabs.overview") },
          { id: "skillmd", label: t("skill.tabs.skillmd") },
          { id: "files", label: t("skill.tabs.files"), n: count },
        ]}
        on={detail.tab}
        onTab={onTab}
      />
      {main}
    </>
  );
}

export function ConnectorPage({ c, a, detail, project, onBack, onTab }: { c: Customize; a: Actions; detail: Detail; project: string | null; onBack: () => void; onTab: (tab: string) => void }) {
  const server = detail.catalog ? null : (c.servers.find((s) => s.name === detail.id) ?? null);
  const cat = detail.catalog ? (catalogConnectors.find((x) => x.id === detail.id) ?? null) : null;
  const added = cat ? addedConnector(c.servers, cat) : null;
  // Added from its page: the page of the server it became.
  useEffect(() => {
    if (added) a.open({ kind: "connector", id: added.name, tab: "overview" });
  }, [added, a]);
  const gone = c.loaded && !server && !cat;
  useEffect(() => {
    if (gone) onBack();
  }, [gone, onBack]);
  if (server) return <ServerPage c={c} a={a} s={server} tab={detail.tab} project={project} onBack={onBack} onTab={onTab} />;
  if (cat) return <CatalogConnectorPage c={c} a={a} cat={cat} project={project} onBack={onBack} />;
  return null;
}

function ServerPage({ c, a, s, tab, project, onBack, onTab }: { c: Customize; a: Actions; s: McpServerView; tab: string; project: string | null; onBack: () => void; onTab: (tab: string) => void }) {
  const { t } = useTranslation("customize");
  const st = useStore();
  const now = useNow(60_000);
  const cat = catalogOf(s);
  const repo = fromRepo(s);
  const look = statusOf(s, c.checking.has(s.name));
  const source = useStatusSource(look);
  const ok = s.status.state === "ok" && s.enabled;
  const [tools, setTools] = useState<McpToolsResult | null>(null);
  useEffect(() => {
    if (tab !== "tools" || !st.rpc) return;
    let current = true;
    st.rpc.request("mcp/tools", { name: s.name, ...(c.cwd ? { cwd: c.cwd } : {}) }).then(
      (r) => current && setTools(r),
      () => current && setTools({ tools: [], source: "none" }),
    );
    return () => {
      current = false;
    };
  }, [tab, st.rpc, s.name, c.cwd, s.status.checked_at, s.status.state]);
  const name = cat?.name ?? s.name;
  const meta: ReactNode[] = [<Status key="st" look={look} onCheck={() => void c.check(s.name)} withAction={false} />];
  if (cat) meta.push(cat.by);
  const acts = s.editable ? (
    <>
      <button className="btn" onClick={() => a.edit(s)}>
        <Icon name="edit" />
        {t("connector.editButton")}
      </button>
      <MoreButton label={t("more")} items={() => serverMenu(s, a, c, t, false)} />
    </>
  ) : (
    <>
      {s.status.state !== "untrusted" && (
        <button className="btn" onClick={() => void c.check(s.name)}>
          <Icon name="retry" />
          {t("connector.recheck")}
        </button>
      )}
      <MoreButton label={t("more")} items={() => serverMenu(s, a, c, t, false)} />
    </>
  );
  const tabs = [{ id: "overview", label: t("connector.tabs.overview") }, ...(ok ? [{ id: "tools", label: t("connector.tabs.tools"), n: s.status.tools ?? 0 }] : [])];
  const description = cat ? catalogText(t, `catalog.connectors.${cat.id}`) : s.description;
  const auth =
    s.auth === "credential" ? (s.auth_state === "missing" ? t("connector.authMissing") : t("connector.authSaved")) : s.auth === "oauth" ? t("connector.authOauth") : t("connector.authNone");
  let main: ReactNode;
  if (tab === "tools" && ok) {
    const from =
      tools?.source === "session"
        ? t("connector.toolsFromSessions", { count: s.status.sessions ?? 1 })
        : tools?.checked_at
          ? t("connector.toolsChecked", { ago: agoText(new Date(tools.checked_at), now) })
          : "";
    main = (
      <div className="cz-pane">
        <div className="cz-tsrc">
          <Icon name="info" />
          <span>{from}</span>
          <button className="link" onClick={() => void c.check(s.name)}>
            {t("connector.recheck")}
          </button>
        </div>
        {tools === null ? (
          <div className="cz-wait">{t("loading")}</div>
        ) : tools.tools.length === 0 ? (
          <div className="cz-wait">{t("connector.noTools")}</div>
        ) : (
          <div className="fgroup cz-tools">
            {tools.tools.map((tool) => (
              <div key={tool.name} className="frow">
                <div>
                  <div className="mono">{tool.name}</div>
                  {(tool.description || tool.title) && <div className="fdesc">{tool.description || tool.title}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  } else {
    main = (
      <div className="cz-cols">
        <div>
          {description && (
            <div className="cz-dsec">
              <h4>{t("connector.description")}</h4>
              <p>{description}</p>
            </div>
          )}
          {s.status.state === "untrusted" ? (
            <div className="cz-dsec">
              <Callout warn icon="warn">
                <Trans t={t} i18nKey="connector.untrustedNote" components={{ code: <code /> }} />
              </Callout>
            </div>
          ) : (
            repo && (
              <div className="cz-dsec">
                <Callout>
                  <Trans t={t} i18nKey="connector.repoNote" values={{ file: s.layer === "project_json" ? ".mcp.json" : ".finx/config.toml" }} components={{ code: <code /> }} />
                </Callout>
              </div>
            )
          )}
          {s.enabled && s.status.state === "failed" && !c.checking.has(s.name) && (
            <div className="cz-dsec">
              <h4>{t("connector.failedTitle")}</h4>
              <div className="cz-errbox">{s.status.error}</div>
              <button className="btn cz-after" onClick={() => void c.check(s.name)}>
                <Icon name="retry" />
                {t("connector.reconnect")}
              </button>
            </div>
          )}
          {s.enabled && s.status.state === "needs_login" && (
            <div className="cz-dsec">
              <Callout warn icon="warn">
                {t("connector.loginNote", { name })}
              </Callout>
              {c.signingIn.has(s.name) ? (
                <div className="cz-after cz-waiting">
                  <span className="mini-spin cz-spin" />
                  {t("connector.signingIn")}
                  <button className="link" data-authorize={c.signingIn.get(s.name)} onClick={() => void navigator.clipboard?.writeText(c.signingIn.get(s.name) ?? "")}>
                    {t("addc.copyLink")}
                  </button>
                </div>
              ) : (
                <button className="btn primary cz-after" onClick={() => void c.login(s.name)}>
                  {t("connector.signIn")}
                </button>
              )}
            </div>
          )}
          <div className="cz-dsec">
            <h4>{t("connector.config")}</h4>
            <div className="fgroup cz-conf">
              <div className="frow">
                <span className="fl">{s.transport === "http" ? t("connector.address") : t("connector.command")}</span>
                <span className="fv mono">{s.summary}</span>
              </div>
              <div className="frow">
                <span className="fl">{t("connector.auth")}</span>
                <span className="fv">{auth}</span>
              </div>
              {s.file && (
                <div className="frow">
                  <span className="fl">{t("connector.writtenIn")}</span>
                  <span className="fv mono">{tilde(s.file)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
        <aside className="cz-side">
          {s.status.state !== "untrusted" && (
            <Fact k={repo ? t("connector.enabledForYou") : t("connector.enabled")}>
              <Switch on={s.enabled} label={s.enabled ? t("connector.turnOff") : t("connector.turnOn")} onChange={(on) => a.toggleServer(s, on)} />
            </Fact>
          )}
          <Fact k={t("connector.provider")}>{cat?.by ?? (repo ? t("connector.providerRepo") : t("connector.providerCustom"))}</Fact>
          <Fact k={t("connector.scope")}>{t(`connector.scopeOf.${connectorGroup(s.layer)}`, { project })}</Fact>
          {ok && (
            <>
              <Fact k={t("connector.statusFrom")}>{source}</Fact>
              <Fact k={t("connector.tools")}>{t("connector.toolCount", { count: s.status.tools ?? 0 })}</Fact>
            </>
          )}
        </aside>
      </div>
    );
  }
  return (
    <>
      <Back label={t("connector.back")} onBack={onBack} />
      <Hero tile={<ServerTile name={name} mono={cat?.mono} icon={s.icon} size="xl" />} name={name} badge={!cat && !repo && <span className="badge">{t("connector.custom")}</span>} meta={meta} acts={acts} />
      <Tabs tabs={tabs} on={ok ? tab : "overview"} onTab={onTab} />
      {main}
    </>
  );
}

/** A catalog connector not added yet: what it is, what will run, and where it will be written. */
function CatalogConnectorPage({ c, a, cat, project, onBack }: { c: Customize; a: Actions; cat: CatalogConnector; project: string | null; onBack: () => void }) {
  const { t } = useTranslation("customize");
  const [token, setToken] = useState("");
  const [missing, setMissing] = useState(false);
  const auth = cat.install.auth;
  const command = commandLine(cat);
  const busy = c.adding.has(`server:${cat.id}`);
  const file = c.layerInfo("user")?.file;
  const add = () => {
    if (auth.kind === "token" && !token.trim()) {
      setMissing(true);
      return;
    }
    a.addConnector(cat, "user", token.trim() || undefined);
  };
  return (
    <>
      <Back label={t("connector.back")} onBack={onBack} />
      <Hero
        tile={<ServerTile name={cat.name} mono={cat.mono} size="xl" />}
        name={cat.name}
        meta={[cat.by]}
        acts={<SolidAdd busy={busy} label={t("connector.add")} busyLabel={t("connector.adding")} onAdd={add} />}
      />
      <Tabs tabs={[{ id: "overview", label: t("connector.tabs.overview") }]} on="overview" onTab={() => {}} />
      <div className="cz-cols">
        <div>
          <div className="cz-dsec">
            <h4>{t("connector.description")}</h4>
            <p>{catalogText(t, `catalog.connectors.${cat.id}`)}</p>
          </div>
          {command ? (
            <div className="cz-dsec">
              <h4>{t("connector.runsHere")}</h4>
              <pre className="cz-code cz-line">{command}</pre>
              <p className="hint">{t("connector.runsHereHint")}</p>
            </div>
          ) : (
            <div className="cz-dsec">
              <h4>{t("connector.address")}</h4>
              <pre className="cz-code cz-line">{"url" in cat.install ? cat.install.url : ""}</pre>
            </div>
          )}
          {auth.kind === "token" && (
            <div className="cz-dsec">
              <h4>{catalogText(t, `catalog.tokens.${cat.id}`, { env: auth.env })}</h4>
              <input
                className={`field mono ${missing ? "bad" : ""}`}
                type="password"
                autoFocus
                placeholder={auth.placeholder}
                value={token}
                onChange={(e) => (setToken(e.target.value), setMissing(false))}
                onKeyDown={(e) => e.key === "Enter" && add()}
              />
              <p className="hint">
                {t("connector.tokenHint")}{" "}
                <button className="link" onClick={() => window.finx?.openExternal(auth.createURL)}>
                  {t("connector.getToken", { by: cat.by })}
                </button>
              </p>
            </div>
          )}
        </div>
        <aside className="cz-side">
          <Fact k={t("connector.provider")}>{cat.by}</Fact>
          {file && (
            <Fact k={t("connector.writes")} stack mono>
              {tilde(file)}
            </Fact>
          )}
          <Fact k="">
            <button className="link" onClick={() => window.finx?.openExternal(cat.docs)}>
              {t("connector.docs")}
            </button>
          </Fact>
        </aside>
      </div>
    </>
  );
}
