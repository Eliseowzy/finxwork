import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { modelGroups, recentModels } from "@finx/client";
import type { ModelsListResult } from "@finx/protocol";
import { menuModels, type MenuModel } from "../format";
import { Icon } from "../icons";
import { useStore } from "../store";
import { MenuItem } from "./Composer";

/** The list shows about a dozen rows (.mlist); past that it scrolls, and a search and the recent models help. */
const LONG = 12;
const foldedKey = "model-menu-folded";

function savedFolds(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(foldedKey) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/**
 * A model menu's models (menuModels), by provider: each provider's name over
 * its models, held at the list's top while they scroll, so a row shows only
 * the model's name. A click on a provider's name folds its group, remembered;
 * the current model's group stays open. With `search` and a long list, a
 * search field comes first, which typing on any row goes to, and the models
 * the last sessions used, each with its provider, over the groups.
 */
export function ModelList({ models, current, search = false, onPick }: {
  models: ModelsListResult;
  current?: string | null;
  search?: boolean;
  onPick: (m: MenuModel) => void;
}) {
  const { t } = useTranslation("session");
  const st = useStore();
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState(savedFolds);
  const box = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const list = menuModels(models, current);
  const long = search && list.length > LONG;
  const groups = modelGroups(list, models.providers, query);
  const own = list.find((m) => m.id === current)?.provider;
  const recent = long && !query ? recentModels(st.sessions, Infinity).flatMap((id) => list.find((m) => m.id === id) ?? []).slice(0, 3) : [];
  const providerName = (id: string) => models.providers.find((p) => p.id === id)?.name ?? id;
  const rows = () => [...(box.current?.querySelectorAll<HTMLElement>(".mlist [role^=menuitem]:not(:disabled)") ?? [])];

  useEffect(() => {
    if (!long) return;
    const menu = box.current?.closest<HTMLElement>("[role=menu]");
    if (!menu) return;
    // A search that shortens the rows keeps the menu's width.
    menu.style.minWidth = `${menu.offsetWidth}px`;
    // Opened by the mouse (the menu itself has the focus): ready to type.
    if (document.activeElement === menu) find.current?.focus();
  }, [long]);

  const fold = (provider: string) => {
    const next = new Set(folded);
    if (!next.delete(provider)) next.add(provider);
    setFolded(next);
    try {
      localStorage.setItem(foldedKey, JSON.stringify([...next]));
    } catch {
      // Not remembered, still folded.
    }
  };
  // Typing on a row goes to the search.
  const typed = (e: KeyboardEvent) => {
    if (!long || e.target === find.current || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.key.length === 1 && e.key !== " ") || e.key === "Backspace") find.current?.focus();
  };
  // In the field: ↓ goes to the rows, ↩ takes the first, Esc clears what is typed; ↑, Tab and Esc on an empty field are the menu's.
  const fieldKeys = (e: KeyboardEvent) => {
    if (e.key === "ArrowUp" || e.key === "Tab" || (e.key === "Escape" && !query)) return;
    e.stopPropagation();
    if (e.key === "ArrowDown") rows()[0]?.focus();
    else if (e.key === "Enter") rows()[0]?.click();
    else if (e.key === "Escape") setQuery("");
    else return;
    e.preventDefault();
  };
  const item = (m: MenuModel, value?: string) => (
    <MenuItem key={m.id} checked={m.id === current} label={m.name} value={m.note ? t(`composer.${m.note}`) : value} onClick={() => onPick(m)} />
  );

  return (
    <div className="mmodels" ref={box} onKeyDown={typed}>
      {long && (
        <label className="mfind">
          <Icon name="search" className="sm" />
          <input ref={find} value={query} placeholder={t("composer.findModel")} spellCheck={false} onChange={(e) => setQuery(e.target.value)} onKeyDown={fieldKeys} />
        </label>
      )}
      <div className="mlist">
        {recent.length > 0 && (
          <div role="group" aria-label={t("composer.recentModels")}>
            <div className="mgh">{t("composer.recentModels")}</div>
            {recent.map((m) => item(m, providerName(m.provider)))}
          </div>
        )}
        {groups.map((g) => {
          const fixed = !!query || g.provider === own;
          const open = fixed || !folded.has(g.provider);
          return (
            <div key={g.provider} role="group" aria-label={g.name}>
              {fixed ? (
                <div className="mgh">{g.name}</div>
              ) : (
                <button className="mgh" tabIndex={-1} aria-expanded={open} onClick={() => fold(g.provider)}>
                  {g.name}
                  <Icon name="chevD" className="sm" />
                </button>
              )}
              {open && g.models.map((m) => item(m))}
            </div>
          );
        })}
        {groups.length === 0 && <div className="mempty">{t("composer.noModel")}</div>}
      </div>
    </div>
  );
}
