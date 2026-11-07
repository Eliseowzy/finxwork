import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PptxFontFamily } from "./fonts";
import { useTranslation } from "react-i18next";
import {
  ToolbarButton, ToolbarCommand, ToolbarCommandButton, ToolbarDropdown, ToolbarMenuItem, ToolbarMenuSeparator,
  usePptxCommand, usePptxCommandState, usePptxCommands, useTranslation as useOfficeTranslation,
} from "@betteroffice/pptx-react";
import { COLLAPSED, COMPACT, FULL, narrower, type RibbonLevel } from "./ribbonFit";
import { RibbonIcon, type RibbonIconName } from "./ribbonIcons";
import { fontMenu, type FontEntry } from "./fontMenu";
import { useController, useCommandText } from "./ribbon/controls";
import { RIcon } from "./ribbon/icons";

/** The host's fonts: the machine's families, and loading one into the running editor. */
export interface RibbonFonts {
  documentFamilies: readonly string[];
  installed(): Promise<PptxFontFamily[]>;
  /** Fetches the family's faces and registers them with the editor; resolves when it can draw them. */
  use(entry: FontEntry): Promise<void>;
}

type TabId = "home" | "insert" | "shape";

interface Group {
  id: string;
  label: string;
  icon: RibbonIconName;
  /** Higher stays expanded longer. */
  priority: number;
  hasCompact: boolean;
  render(level: typeof FULL | typeof COMPACT): ReactNode;
}

/** Keeps the canvas selection while toolbar buttons are pressed, as the library's own toolbar does. */
function keepSelection(event: React.MouseEvent) {
  const target = event.target as HTMLElement;
  if (!target.closest("input, textarea, select, option")) event.preventDefault();
}

/** A ribbon button with an icon and, in the full layout, its caption. */
function Tile({ icon, label, captioned, large, active, disabled, description, onClick, testId }: {
  icon: RibbonIconName; label: string; captioned: boolean; large?: boolean; active?: boolean;
  disabled?: boolean; description?: string; onClick: () => void; testId?: string;
}) {
  return <ToolbarButton title={label} active={active} disabled={disabled} description={description} onClick={onClick} testId={testId}
    className={`pptx-rb-tile${large ? " pptx-rb-tile-large" : ""}${captioned ? " pptx-rb-captioned" : ""}`}>
    <RibbonIcon name={icon} size={large ? 28 : 18} />{captioned && <span className="pptx-rb-caption">{label}</span>}
  </ToolbarButton>;
}

function NewSlide({ level }: { level: RibbonLevel }) {
  const { t } = useOfficeTranslation();
  const command = usePptxCommand("insertSlide", {});
  return <div className="pptx-rb-stack">
    <Tile icon="slide" label={t("toolbar.newSlide")} captioned={level === FULL} large={level === FULL} disabled={!command.state.enabled}
      description={command.state.disabledReason?.message} onClick={() => void command.execute({})} testId="pptx-rb-new-slide" />
    <ToolbarCommand id="insertSlide" />
  </div>;
}

function ToolTile({ value, icon, label, level }: { value: "select" | "textBox"; icon: RibbonIconName; label: string; level: RibbonLevel }) {
  const command = usePptxCommand("tool", { value });
  return <Tile icon={icon} label={label} captioned={level === FULL} active={command.state.value === value} disabled={!command.state.enabled}
    description={command.state.disabledReason?.message} onClick={() => void command.execute({ value })} />;
}

function ImageTile({ level }: { level: RibbonLevel }) {
  const { t } = useTranslation("session");
  const command = usePptxCommand("insertImage", null);
  return <Tile icon="image" label={t("pptx.ribbon.image")} captioned={level === FULL} disabled={!command.state.enabled}
    description={command.state.disabledReason?.message} onClick={() => void command.execute(null)} />;
}

/** The machine's families, as PowerPoint lists them: this deck's fonts, then every installed one, each in its own face. */
function FontPicker({ fonts, compact }: { fonts: RibbonFonts; compact: boolean }) {
  const { t, i18n } = useTranslation("session");
  const { t: office } = useOfficeTranslation();
  const state = usePptxCommandState("fontFamily");
  const commands = usePptxCommands();
  const [installed, setInstalled] = useState<PptxFontFamily[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fonts.installed().then((list) => { if (live) setInstalled(list); }, (e: unknown) => {
      if (live) { setInstalled([]); setFailed(t("pptx.ribbon.fontsUnavailable", { message: e instanceof Error ? e.message : String(e) })); }
    });
    return () => { live = false; };
  }, [fonts, t]);
  const menu = useMemo(() => fontMenu(installed ?? [], fonts.documentFamilies, i18n.language, query), [installed, fonts, i18n.language, query]);
  const current = state.value ?? null;
  const entryFor = (family: string): FontEntry => fontMenu(installed ?? [], [family], i18n.language).document[0] ?? { family, label: family, cjk: false };
  const themeLabel = (slot: "major" | "minor", family: string) =>
    office(slot === "major" ? "toolbar.themeFontHeadings" : "toolbar.themeFontBody", { family });
  const themeFonts = state.themeFonts ?? null;
  // PowerPoint lists the theme's heading and body fonts first; picking one writes +mj-lt / +mn-lt, not the family.
  const themeEntries = themeFonts ? (["major", "minor"] as const).map((slot) => ({ slot, entry: entryFor(themeFonts[slot].latin) }))
    .filter(({ slot, entry }) => !query.trim() || themeLabel(slot, entry.label).toLowerCase().includes(query.trim().toLowerCase())) : [];
  const currentLabel = current === null ? office("toolbar.mixed")
    : state.theme ? themeLabel(state.theme, entryFor(current).label) : entryFor(current).label;
  const choose = async (entry: FontEntry, close: () => void, theme?: "major" | "minor") => {
    setBusy(theme ?? entry.family);
    setFailed(null);
    try {
      await fonts.use(entry);
      const result = await commands.execute("fontFamily", theme ? { theme } : { family: entry.family });
      if (!result.ok) throw new Error(result.failure.message);
      close();
    } catch (e) {
      setFailed(t("pptx.ribbon.fontFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };
  const item = (entry: FontEntry, close: () => void) => <button key={entry.family} type="button" role="option" aria-selected={entry.family === current}
    className="pptx-font-item" disabled={busy !== null} onClick={() => void choose(entry, close)} data-family={entry.family}>
    <span className="pptx-font-check">{!state.theme && entry.family.toLowerCase() === current?.toLowerCase() ? "✓" : ""}</span>
    <span className="pptx-font-name" style={{ fontFamily: `"${entry.family}", system-ui` }}>{entry.label}</span>
    {entry.substitute && <span className="pptx-font-substitute" title={t("pptx.ribbon.fontSubstituteHint", { family: entry.substitute })}>{t("pptx.ribbon.fontSubstitute")}</span>}
    {busy === entry.family && <span className="pptx-font-busy">{t("pptx.ribbon.fontLoading")}</span>}
  </button>;
  return <ToolbarDropdown title={office("toolbar.fontFamily")} disabled={!state.enabled} description={state.disabledReason?.message} popup="dialog" menuWidth={280}
    testId="pptx-font-family" trigger={<span className={`pptx-font-trigger${compact ? " pptx-font-trigger-compact" : ""}`}>
      <span className="pptx-font-current">{currentLabel}</span><RibbonIcon name="chevron" size={12} /></span>}>
    {(close) => <div className="pptx-font-menu" onMouseDown={keepSelection}>
      <input className="pptx-font-search" autoFocus value={query} placeholder={t("pptx.ribbon.fontSearch")} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { const first = menu.document[0] ?? menu.all[0]; if (e.key === "Enter" && first) void choose(first, close); }} />
      {failed && <div className="pptx-font-error" role="alert">{failed}</div>}
      <div className="pptx-font-list" role="listbox" aria-label={office("toolbar.fontFamily")}>
        {themeEntries.length > 0 && <div className="pptx-font-section">{office("toolbar.themeFonts")}</div>}
        {themeEntries.map(({ slot, entry }) => <button key={`theme-${slot}`} type="button" role="option" aria-selected={state.theme === slot}
          className="pptx-font-item" disabled={busy !== null} onClick={() => void choose(entry, close, slot)} data-theme-font={slot}>
          <span className="pptx-font-check">{state.theme === slot ? "✓" : ""}</span>
          <span className="pptx-font-name" style={{ fontFamily: `"${entry.family}", system-ui` }}>{themeLabel(slot, entry.label)}</span>
          {busy === slot && <span className="pptx-font-busy">{t("pptx.ribbon.fontLoading")}</span>}
        </button>)}
        {menu.document.length > 0 && <div className="pptx-font-section">{t("pptx.ribbon.documentFonts")}</div>}
        {menu.document.map((entry) => item(entry, close))}
        {menu.all.length > 0 && <div className="pptx-font-section">{t("pptx.ribbon.allFonts")}</div>}
        {installed === null ? <div className="pptx-font-empty">{t("pptx.ribbon.fontLoading")}</div> : menu.all.map((entry) => item(entry, close))}
      </div>
    </div>}
  </ToolbarDropdown>;
}

/** Re-renders on every command-layer state change (selection, document, painter, clipboard). */
function useRibbonState() {
  const controller = useController();
  return useSyncExternalStore(controller.subscribe, controller.state);
}

/** A button for a command-layer command (commands/registry.ts): status, reason and shortcut come from the controller. */
function Cmd({ cmd, icon, args, captioned = false, large, onDoubleClick }: {
  cmd: string; icon: string; args?: unknown; captioned?: boolean; large?: boolean; onDoubleClick?: () => void;
}) {
  const controller = useController();
  useRibbonState();
  const status = controller.status(cmd, args);
  const { label, title, reason } = useCommandText()(cmd, status);
  const button = <ToolbarButton title={label} active={typeof status.active === "boolean" ? status.active : status.active === "mixed" ? "mixed" : undefined}
    disabled={!status.enabled} description={reason || title} testId={`pptx-cmd-${cmd}`} onClick={() => void controller.run(cmd, args)}
    className={`pptx-rb-tile${large ? " pptx-rb-tile-large" : ""}${captioned ? " pptx-rb-captioned" : ""}`}>
    <RIcon name={icon} className={large ? "pptx-rb-icon-large" : "pptx-rb-icon"} />{captioned && <span className="pptx-rb-caption">{label}</span>}
  </ToolbarButton>;
  return onDoubleClick ? <span className="pptx-rb-dbl" onDoubleClick={onDoubleClick}>{button}</span> : button;
}

/** A menu of command-layer commands; a separator goes before each item marked `sep`. */
function CmdMenu({ id, icon, items }: { id: string; icon: string; items: readonly { cmd: string; icon: string; sep?: boolean }[] }) {
  const controller = useController();
  useRibbonState();
  const text = useCommandText();
  const { t } = useTranslation("session");
  const label = t(`pptx.ribbon.group.${id}` as never) as string;
  const enabled = items.some((item) => controller.status(item.cmd).enabled);
  return <ToolbarDropdown title={label} popup="menu" disabled={!enabled} testId={`pptx-menu-${id}`}
    trigger={<span className="pptx-rb-menu-trigger"><RIcon name={icon} className="pptx-rb-icon" /><RibbonIcon name="chevron" size={10} /></span>}>
    {(close) => items.flatMap((item) => {
      const status = controller.status(item.cmd);
      const { label: itemLabel, reason } = text(item.cmd, status);
      const row = <ToolbarMenuItem key={item.cmd} label={itemLabel} icon={<RIcon name={item.icon} className="pptx-rb-icon" />}
        selected={status.active === true} disabled={!status.enabled} description={reason || undefined} close={close}
        onClick={() => void controller.run(item.cmd)} />;
      return item.sep ? [<ToolbarMenuSeparator key={`${item.cmd}-sep`} />, row] : [row];
    })}
  </ToolbarDropdown>;
}

const ALIGN_ITEMS = [
  { cmd: "align.left", icon: "AlignStartVertical" }, { cmd: "align.center", icon: "AlignCenterVertical" }, { cmd: "align.right", icon: "AlignEndVertical" },
  { cmd: "align.top", icon: "AlignStartHorizontal", sep: true }, { cmd: "align.middle", icon: "AlignCenterHorizontal" }, { cmd: "align.bottom", icon: "AlignEndHorizontal" },
  { cmd: "distribute.horizontal", icon: "AlignHorizontalDistributeCenter", sep: true }, { cmd: "distribute.vertical", icon: "AlignVerticalDistributeCenter" },
  { cmd: "alignToPage", icon: "Frame", sep: true },
] as const;

function useGroups(fonts: RibbonFonts): Record<TabId, Group[]> {
  const { t: office } = useOfficeTranslation();
  const { t } = useTranslation("session");
  const clipboard: Group = { id: "clipboard", label: t("pptx.ribbon.group.clipboard"), icon: "clipboard", priority: 6, hasCompact: true,
    render: (level) => <div className="pptx-rb-row">
      <Cmd cmd="paste" icon="ClipboardPaste" captioned={level === FULL} large={level === FULL} />
      <div className="pptx-rb-rows">
        <div className="pptx-rb-row"><Cmd cmd="cut" icon="Scissors" /><Cmd cmd="copy" icon="Copy" /></div>
        <div className="pptx-rb-row"><FormatPainter /><Cmd cmd="duplicate" icon="CopyPlus" /></div>
      </div>
    </div> };
  const slides: Group = { id: "slides", label: office("toolbar.groups.slides"), icon: "slide", priority: 3, hasCompact: true,
    render: (level) => <div className="pptx-rb-row"><NewSlide level={level} /><Cmd cmd="deleteSlide" icon="Trash2" /></div> };
  const font: Group = { id: "font", label: office("toolbar.groups.font"), icon: "font", priority: 10, hasCompact: true,
    render: (level) => <div className={`pptx-rb-rows${level === COMPACT ? " pptx-rb-font-compact" : ""}`}>
      <div className="pptx-rb-row">
        <FontPicker fonts={fonts} compact={level === COMPACT} />
        <ToolbarCommand id="fontSize" />
        <ToolbarCommandButton id="fontSizeStep" args={{ direction: "increase" }} />
        <ToolbarCommandButton id="fontSizeStep" args={{ direction: "decrease" }} />
      </div>
      <div className="pptx-rb-row">
        <ToolbarCommandButton id="bold" />
        <ToolbarCommandButton id="italic" />
        <ToolbarCommandButton id="underline" />
        <Cmd cmd="superscript" icon="Superscript" />
        <Cmd cmd="subscript" icon="Subscript" />
        <ToolbarCommand id="textColor" />
        <Cmd cmd="clearFormat" icon="RemoveFormatting" />
      </div>
    </div> };
  const paragraph: Group = { id: "paragraph", label: t("pptx.ribbon.paragraph"), icon: "paragraph", priority: 8, hasCompact: true,
    render: (level) => level === FULL
      ? <div className="pptx-rb-row">{(["l", "ctr", "r", "just"] as const).map((value) =>
        <ToolbarCommandButton key={value} id="alignment" args={{ value }} />)}</div>
      : <ToolbarCommand id="alignment" /> };
  const insert = (priority: number): Group => ({ id: "insert", label: t("pptx.ribbon.insert"), icon: "insert", priority, hasCompact: true,
    render: (level) => <div className="pptx-rb-row">
      <ToolTile value="select" icon="pointer" label={t("pptx.ribbon.select")} level={COMPACT} />
      <ToolTile value="textBox" icon="textBox" label={office("toolbar.textBoxTool")} level={level} />
      <ImageTile level={level} />
    </div> });
  const arrange: Group = { id: "arrange", label: office("toolbar.arrange"), icon: "arrange", priority: 2, hasCompact: false,
    render: () => <div className="pptx-rb-row"><ToolbarCommand id="zOrder" /><CmdMenu id="alignObjects" icon="AlignStartVertical" items={ALIGN_ITEMS} /></div> };
  const editing: Group = { id: "editing", label: t("pptx.ribbon.group.editing"), icon: "pointer", priority: 0, hasCompact: false,
    render: () => <div className="pptx-rb-row"><Cmd cmd="selectAll" icon="SquareMousePointer" /></div> };
  const shapeStyle: Group = { id: "shapeStyle", label: t("pptx.ribbon.shapeStyle"), icon: "drawing", priority: 4, hasCompact: false,
    render: () => <div className="pptx-rb-row">
      <ToolbarCommand id="shapeFill" />
      <ToolbarCommand id="shapeStrokeColor" />
      <ToolbarCommand id="shapeStrokeWidth" />
    </div> };
  const adjust: Group = { id: "adjust", label: office("toolbar.shapeAdjustment"), icon: "adjust", priority: 1, hasCompact: false,
    render: () => <div className="pptx-rb-row"><ToolbarCommand id="shapeAdjustment" /></div> };
  return {
    home: [clipboard, slides, font, paragraph, insert(5), { ...shapeStyle, priority: 2 }, { ...arrange, priority: 1 }, editing],
    insert: [{ ...slides, priority: 6 }, insert(8)],
    shape: [shapeStyle, adjust, arrange],
  };
}

/** Click: paint once. Double click: keep painting until Esc or a second click. */
function FormatPainter() {
  const controller = useController();
  return <Cmd cmd="formatPainter" icon="Paintbrush" onDoubleClick={() => void controller.run("formatPainter", { sticky: true })} />;
}

/** The agent's proposals and the slideshow, which the library mounts only beside its own toolbar. */
function RibbonActions() {
  const { t } = useOfficeTranslation();
  const proposals = usePptxCommand("proposalsPanel", null);
  const count = usePptxCommandState("proposalSelect").options?.length ?? 0;
  const show = usePptxCommand("slideshow", null);
  const hasProposals = proposals.state.disabledReason?.code !== "proposals-unavailable";
  return <div className="pptx-rb-actions">
    {hasProposals && <button type="button" className="pptx-rb-action" data-testid="pptx-proposals-button" aria-expanded={proposals.state.value ?? false}
      disabled={!proposals.state.enabled} title={proposals.state.disabledReason?.message} onClick={() => void proposals.execute(null)}>
      {t("proposals.title")} <span data-testid="pptx-proposals-count">{count}</span></button>}
    <button type="button" className="pptx-rb-action pptx-rb-present" data-testid="pptx-present" disabled={!show.state.enabled}
      title={show.state.disabledReason?.message} onClick={() => void show.execute(null)}>
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z" fill="currentColor" /></svg>{t("toolbar.present")}</button>
  </div>;
}

/** One group in its current form; collapsed it becomes a labelled button that opens the group. */
function RibbonGroup({ group, level }: { group: Group; level: RibbonLevel }) {
  if (level === COLLAPSED) {
    return <div className="pptx-rb-group pptx-rb-collapsed" role="group" aria-label={group.label} data-ribbon-group={group.id}>
      <ToolbarDropdown title={group.label} popup="dialog" testId={`pptx-rb-group-${group.id}`}
        trigger={<span className="pptx-rb-fold"><RibbonIcon name={group.icon} size={26} /><span>{group.label}</span><RibbonIcon name="chevron" size={10} /></span>}>
        {() => <div className="pptx-rb-popover" onMouseDown={keepSelection}>{group.render(FULL)}</div>}
      </ToolbarDropdown>
    </div>;
  }
  return <div className="pptx-rb-group" role="group" aria-label={group.label} data-ribbon-group={group.id} data-level={level}>{group.render(level)}</div>;
}

/**
 * PowerPoint-style chrome for the presentation editor: tabs over one row of
 * groups. As the panel narrows, groups drop captions, then fold in place into
 * labelled buttons, lowest priority first, so nothing hides behind a "more" menu.
 */
export function Ribbon({ fonts }: { fonts: RibbonFonts }) {
  const { t } = useTranslation("session");
  const { t: office } = useOfficeTranslation();
  const groups = useGroups(fonts);
  const shapeTab = usePptxCommandState("shapeFill").enabled;
  const [chosen, setTab] = useState<TabId>("home");
  const tab: TabId = chosen === "shape" && !shapeTab ? "home" : chosen;
  const active = groups[tab];
  const [levels, setLevels] = useState<Record<string, RibbonLevel>>({});
  const row = useRef<HTMLDivElement>(null);
  const width = useRef(-1);

  // Start from the widest form whenever the tab or available width changes, then
  // step narrower until the row fits. Runs before paint, so no stage flashes.
  const refit = useCallback(() => {
    width.current = row.current?.clientWidth ?? 0;
    setLevels({});
  }, []);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { if (element.clientWidth !== width.current) refit(); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [refit]);
  useLayoutEffect(refit, [tab, refit]);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element || element.scrollWidth <= element.clientWidth + 1) return;
    const next = narrower(active, levels);
    if (next) setLevels(next);
  });

  const tabs: { id: TabId; label: string }[] = [
    { id: "home", label: t("pptx.ribbon.home") },
    { id: "insert", label: t("pptx.ribbon.insert") },
    ...(shapeTab ? [{ id: "shape" as const, label: office("toolbar.groups.shape") }] : []),
  ];
  return <div className="pptx-ribbon" data-testid="pptx-ribbon" role="toolbar" aria-label={office("toolbar.label")} onMouseDown={keepSelection}>
    <div className="pptx-rb-tabs">
      <div className="pptx-rb-quick">
        <ToolbarCommandButton id="undo" />
        <ToolbarCommandButton id="redo" />
        <span className="pptx-rb-sep" />
        <ToolbarCommandButton id="save" />
        <ToolbarCommandButton id="exportPng" />
      </div>
      <div className="pptx-rb-tablist" role="tablist">
        {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === tab}
          className={`pptx-rb-tab${item.id === "shape" ? " pptx-rb-contextual" : ""}`} data-testid={`pptx-rb-tab-${item.id}`}
          onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
      <div className="pptx-rb-zoom"><ToolbarCommand id="zoom" /></div>
      <RibbonActions />
    </div>
    <div className="pptx-rb-row-main" ref={row} role="tabpanel">
      {active.map((group, index) => <div key={group.id} className="pptx-rb-slot">
        {index > 0 && <span className="pptx-rb-divider" />}
        <RibbonGroup group={group} level={levels[group.id] ?? FULL} />
      </div>)}
    </div>
  </div>;
}
