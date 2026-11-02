import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Preferences } from "../../../shared/bridge";
import { allEngines, engineProblem, templateOf, type SearchEngine } from "../../../shared/search";
import { Dialog } from "../components";
import { Icon } from "../icons";

// Settings › Browser › 内置浏览器: how the address field of FinxWork's own browser panel searches,
// which is not the user's own browser's. The engine on the page; the engines with their keywords
// (typed in the address field, then Tab or Space: a search with it) in a dialog, where the
// person's own can be added and removed.

/** An engine's icon: its site's favicon, or its initial while there is none. */
export function EngineIcon({ engine, className = "" }: { engine: Pick<SearchEngine, "name" | "url">; className?: string }) {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setIcon(null);
    void window.finx?.searchEngineIcon(engine.url).then((src) => live && setIcon(src));
    return () => {
      live = false;
    };
  }, [engine.url]);
  return icon ? (
    <img className={`engine-icon ${className}`} src={icon} alt="" draggable={false} />
  ) : (
    <span className={`engine-icon engine-initial ${className}`} aria-hidden="true">{[...engine.name.trim()][0]?.toUpperCase() ?? "?"}</span>
  );
}

export function BuiltInBrowser() {
  const { t } = useTranslation("settings");
  const [prefs, setPrefs] = useState<Preferences>();
  const [managing, setManaging] = useState(false);
  useEffect(() => {
    window.finx?.getPreferences().then(setPrefs);
  }, []);
  const set = (p: Partial<Preferences>) => window.finx?.setPreferences(p).then(setPrefs);
  const engines = allEngines(prefs?.searchEngines);
  return (
    <section>
      <h3 className="fhead">{t("browser.builtIn.title")}</h3>
      <p className="set-note apps-intro">{t("browser.builtIn.intro")}</p>
      <div className="fgroup">
        <div className="frow search-engine">
          <div className="ft">
            <div className="fn">{t("browser.builtIn.search")}</div>
            <div className="fdesc">{t("browser.builtIn.searchDesc")}</div>
          </div>
          <select className="psel" aria-label={t("browser.builtIn.search")} value={prefs?.searchEngine ?? "google"} disabled={!prefs} onChange={(e) => void set({ searchEngine: e.target.value })}>
            {engines.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
        <div className="frow">
          <div className="ft">
            <div className="fn">{t("browser.builtIn.engines")}</div>
            <div className="fdesc">{t("browser.builtIn.keywordHint")}</div>
          </div>
          <span className="fcount">{t("browser.builtIn.count", { count: engines.length })}</span>
          <button className="btn engines-manage" disabled={!prefs} onClick={() => setManaging(true)}>{t("browser.builtIn.manage")}</button>
        </div>
      </div>
      {managing && prefs && <EnginesDialog prefs={prefs} set={set} onClose={() => setManaging(false)} />}
    </section>
  );
}

/** Every engine with its keyword; the person's own can be removed, and more added. */
function EnginesDialog({ prefs, set, onClose }: { prefs: Preferences; set: (p: Partial<Preferences>) => Promise<void> | undefined; onClose: () => void }) {
  const { t } = useTranslation("settings");
  const [adding, setAdding] = useState(false);
  const engines = allEngines(prefs.searchEngines);
  const custom = prefs.searchEngines ?? [];
  return (
    <Dialog label={t("browser.builtIn.engines")} width={520} className="engines-sheet" onClose={onClose}>
      <h3>{t("browser.builtIn.engines")}</h3>
      <p className="sub">{t("browser.builtIn.keywordHint")}</p>
      <div className="fgroup engines">
        {engines.map((e) => (
          <div className="frow engine-row" key={e.id}>
            <EngineIcon engine={e} />
            <div className="ft">
              <div className="fn">
                {e.name}
                {e.id === prefs.searchEngine && <span className="badge acc">{t("browser.builtIn.default")}</span>}
              </div>
              <div className="fdesc">
                {t("browser.builtIn.keyword")} <code>{e.keyword}</code>
              </div>
            </div>
            {e.custom && (
              <button className="tb" title={t("browser.builtIn.removeNamed", { name: e.name })} aria-label={t("browser.builtIn.removeNamed", { name: e.name })} onClick={() => void set({ searchEngines: custom.filter((c) => c.id !== e.id) })}>
                <Icon name="trash" />
              </button>
            )}
          </div>
        ))}
        {adding ? (
          <AddEngine engines={engines} onCancel={() => setAdding(false)} onAdd={(e) => void set({ searchEngines: [...custom, e] })?.then(() => setAdding(false))} />
        ) : (
          <button className="frow mrow-add" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            {t("browser.builtIn.add")}
          </button>
        )}
      </div>
      <div className="sheet-foot">
        <button className="btn primary" onClick={onClose}>{t("browser.builtIn.done")}</button>
      </div>
    </Dialog>
  );
}

/** A new engine: its name, its keyword, and its search URL with %s where the words go. */
function AddEngine({ engines, onAdd, onCancel }: { engines: SearchEngine[]; onAdd: (e: SearchEngine) => void; onCancel: () => void }) {
  const { t } = useTranslation("settings");
  const [form, setForm] = useState({ name: "", keyword: "", url: "" });
  const [tried, setTried] = useState(false);
  const problem = engineProblem(form, engines);
  const add = () => {
    setTried(true);
    const url = templateOf(form.url);
    if (problem || !url) return;
    onAdd({ id: `custom-${crypto.randomUUID()}`, name: form.name.trim(), keyword: form.keyword.trim(), url, custom: true });
  };
  const field = (key: "name" | "keyword" | "url", placeholder: string) => (
    <label className="engine-field">
      <span>{t(`browser.builtIn.field.${key}`)}</span>
      <input
        className={`field ${key === "name" ? "" : "mono"} ${tried && (problem === key || (key === "keyword" && problem === "keywordTaken")) ? "bad" : ""}`}
        value={form[key]}
        placeholder={placeholder}
        spellCheck={false}
        autoFocus={key === "name"}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
          if (e.key === "Escape") onCancel();
        }}
      />
    </label>
  );
  return (
    <div className="engine-add">
      {field("name", t("browser.builtIn.placeholder.name"))}
      {field("keyword", t("browser.builtIn.placeholder.keyword"))}
      {field("url", "https://example.com/search?q=%s")}
      {tried && problem && <p className="mrow-err">{t(`browser.builtIn.problem.${problem}`)}</p>}
      <div className="bg-actions">
        <button className="btn" onClick={onCancel}>{t("browser.builtIn.cancel")}</button>
        <button className="btn primary" onClick={add}>{t("browser.builtIn.addButton")}</button>
      </div>
    </div>
  );
}
