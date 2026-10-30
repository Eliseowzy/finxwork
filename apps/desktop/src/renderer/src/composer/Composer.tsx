import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { homePath } from "@finx/client";
import type { CommandInfo, ModelsListResult, PermissionMode, ThinkingLevel } from "@finx/protocol";
import { permissionDesc, permissionTitle, modelTitle, thinkingTitle } from "../format";
import { Icon } from "../icons";
import { menuKeys } from "../sidebar/Sidebar";
import { addAttachments, attachEvent, pickFiles, pickFolder, type Attachment } from "./attachments";
import { keyEvent } from "./KeySetup";
import { PromptEditor, type EditorHandle } from "./PromptEditor";
import { Tile } from "./Tile";

/** What a message goes with, shown under the composer and changed there. */
export type Settings = {
  permission: PermissionMode;
  onPermission: (m: PermissionMode) => void;
  model: string | null;
  thinking: ThinkingLevel;
  models: ModelsListResult;
  onModel: (ref: string) => void;
  onThinking: (l: ThinkingLevel) => void;
};

/** Where a new session works: its project, from the recent ones or picked. */
export type Place = { cwd: string | null; recent: string[]; names: Map<string, string>; onCwd: (cwd: string) => void; onPick: () => void };

/**
 * The two forms of the composer, one component. On a session's page it
 * floats over the conversation's bottom (which keeps clear of its height),
 * sends to the session, turns Send into a red Stop while a task runs and
 * nothing is typed, and has an approval pop up above it. On the new
 * session page it sits at the page's bottom and also asks where the
 * session runs and in which project.
 */
export type Form =
  | { mode: "session"; running: boolean; onStop: () => void; above?: ReactNode; onHeight: (h: number) => void }
  | { mode: "new"; place: Place };

/**
 * Where the owner writes to finx: one line while empty — "+", the text,
 * Send — growing with what is written. ↩ sends, ⇧↩ breaks the line, nothing
 * is sent while an input method composes; ⌥↩ sends as a follow-up when a
 * task runs. `/` opens the session's commands; a skill chosen there, or
 * written as `/skill:name`, shows as a tag (PromptEditor). What is attached
 * shows as tiles above the text. What the message goes with is a row of
 * quiet buttons under it, outside.
 */
export function Composer({ form, value, onChange, onSend, placeholder, canSend = true, attachments, onAttachments, settings, commands }: {
  form: Form;
  value: string;
  onChange: (v: string) => void;
  onSend: (followUp: boolean) => void;
  placeholder: string;
  canSend?: boolean;
  attachments: Attachment[];
  onAttachments: (a: Attachment[]) => void;
  settings: Settings;
  /** What `/` offers: the built-in commands and the skills (`skills/list`). */
  commands: CommandInfo[];
}) {
  const { t } = useTranslation("session");
  const area = useRef<EditorHandle>(null);
  const col = useRef<HTMLDivElement>(null);
  const ready = canSend && (value.trim() !== "" || attachments.length > 0);
  // Not away from a field being typed in, such as a title being renamed (a double-click on a row opens its page too).
  useEffect(() => {
    if (!(document.activeElement instanceof HTMLInputElement)) area.current?.focus();
  }, []);
  const onHeight = form.mode === "session" ? form.onHeight : undefined;
  useEffect(() => {
    const el = col.current;
    if (!el || !onHeight) return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      onHeight(0);
    };
  }, [onHeight]);
  const send = (followUp: boolean) => ready && onSend(followUp);
  // A task runs and nothing is typed: Stop, in red, where Send was.
  const stop = form.mode === "session" && form.running && value.trim() === "" && attachments.length === 0 ? form.onStop : null;
  return (
    <div className={`cmp-zone ${form.mode}`}>
      <div className="cmp-col" ref={col}>
        {form.mode === "session" && form.above}
        <div className="cmp" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), area.current?.focus())}>
          {attachments.length > 0 && <Tiles items={attachments} onRemove={(i) => (onAttachments(attachments.filter((_, j) => j !== i)), area.current?.focus())} />}
          <div className="cmp-row">
            <PlusMenu attachments={attachments} onAttachments={(a) => (onAttachments(a), area.current?.focus())} />
            <PromptEditor ref={area} value={value} onChange={onChange} onEnter={send} placeholder={placeholder} label={t("composer.label")} commands={commands} />
            {stop ? (
              <button className="send stop" onClick={stop} title={t("composer.stop")} aria-label={t("composer.stop")}>
                <Icon name="stopFill" />
              </button>
            ) : (
              <button className="send" disabled={!ready} onClick={() => send(false)} title={t("composer.send")} aria-label={t("composer.send")}>
                <Icon name="arrowUp" />
              </button>
            )}
          </div>
        </div>
        <div className="cmp-meta">
          {form.mode === "new" && (
            <>
              <EnvironmentPicker />
              <ProjectPicker place={form.place} />
            </>
          )}
          <PermissionPicker value={settings.permission} onChange={settings.onPermission} />
          <span className="sp" />
          <ModelPicker settings={settings} />
        </div>
      </div>
    </div>
  );
}

/** What is attached, as tiles inside the composer; × takes one off. */
function Tiles({ items, onRemove }: { items: Attachment[]; onRemove: (i: number) => void }) {
  return (
    <div className="cmp-att">
      {items.map((a, i) => (
        <Tile key={a.path} kind={a.kind} path={a.path} name={a.name} src={a.kind === "image" ? `data:${a.mime_type};base64,${a.data}` : undefined} onRemove={() => onRemove(i)} />
      ))}
    </div>
  );
}

/** "+": add files or photos (⌘U), or a folder. The app menu's items reach it too. */
function PlusMenu({ attachments, onAttachments }: { attachments: Attachment[]; onAttachments: (a: Attachment[]) => void }) {
  const { t } = useTranslation("session");
  const latest = useRef({ attachments, onAttachments });
  latest.current = { attachments, onAttachments };
  // Back to the text afterwards, whatever was picked, so writing goes on.
  const add = async (what: "files" | "folder") => {
    const more = what === "files" ? await pickFiles() : [await pickFolder()].filter((a): a is Attachment => a !== null);
    latest.current.onAttachments(addAttachments(latest.current.attachments, more));
  };
  useEffect(() => {
    const on = (e: Event) => void add((e as CustomEvent).detail === "folder" ? "folder" : "files");
    window.addEventListener(attachEvent, on);
    return () => window.removeEventListener(attachEvent, on);
  }, []);
  return (
    <MenuButton className="cmp-plus" title={t("composer.add")} label={<Icon name="plus" />}>
      {(close) => (
        <>
          <MenuItem icon="paperclip" label={t("composer.addFiles")} kbd="⌘U" onClick={() => (close(), void add("files"))} />
          <MenuItem icon="folder" label={t("composer.addFolder")} onClick={() => (close(), void add("folder"))} />
        </>
      )}
    </MenuButton>
  );
}

/**
 * A button that opens a menu above it (the composer sits at the window's
 * bottom), aligned to its left or right edge; the keyboard works as in a
 * native menu.
 */
export function MenuButton({ className, title, label, align = "left", disabled, children }: {
  className: string;
  title: string;
  label: ReactNode;
  align?: "left" | "right";
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [at, setAt] = useState<{ x: number; bottom: number; key: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => setAt(null);
  useLayoutEffect(() => {
    if (!at || !menu.current) return;
    const m = menu.current;
    const r = m.getBoundingClientRect();
    if (r.right > innerWidth - 8) m.style.left = `${Math.max(8, innerWidth - 8 - r.width)}px`;
    if (r.left < 8) m.style.left = "8px";
    (at.key ? (m.querySelector<HTMLElement>("[aria-checked=true]") ?? m.querySelector<HTMLElement>("[role^=menuitem]:not(:disabled)")) : m)?.focus();
  }, [at]);
  useEffect(() => {
    if (!at) return;
    const outside = (e: MouseEvent) => ![btn, menu].some((r) => r.current?.contains(e.target as Node)) && close();
    document.addEventListener("mousedown", outside);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("blur", close);
    };
  }, [at]);
  return (
    <>
      <button
        ref={btn}
        className={className}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={!!at}
        disabled={disabled}
        onClick={(e) => {
          if (at) return close();
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: align === "left" ? r.left : innerWidth - r.right, bottom: innerHeight - r.top + 6, key: e.detail === 0 });
        }}
      >
        {label}
      </button>
      {at && (
        <div
          className="vmenu"
          role="menu"
          aria-label={title}
          tabIndex={-1}
          ref={menu}
          style={align === "left" ? { left: at.x, bottom: at.bottom } : { right: at.x, bottom: at.bottom }}
          onKeyDown={(e) => menuKeys(e, menu.current, () => (close(), btn.current?.focus()))}
        >
          {children(close)}
        </div>
      )}
    </>
  );
}

/**
 * A row that opens a menu beside it (on the right, or on the left when
 * there's no room), showing its current value: hovering or →/↩ opens it,
 * ←/Esc goes back. The submenu lives inside the menu's element, so a click
 * in it is not a click outside.
 */
export function SubMenuItem({ label, value, title, children }: { label: string; value: string; title: string; children: ReactNode }) {
  const [open, setOpen] = useState<{ key: boolean } | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const row = useRef<HTMLButtonElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !row.current || !sub.current) return setAt(null);
    const m = row.current.closest("[role=menu]")!.getBoundingClientRect();
    const r = row.current.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = sub.current;
    setAt({ left: m.right + w + 4 > innerWidth ? m.left - w - 2 : m.right + 2, top: Math.max(8, Math.min(r.top - 5, innerHeight - 8 - h)) });
    if (open.key) (sub.current.querySelector<HTMLElement>("[aria-checked=true]") ?? sub.current.querySelector<HTMLElement>("[role^=menuitem]"))?.focus();
  }, [open]);
  const back = () => (setOpen(null), row.current?.focus());
  return (
    <div style={{ display: "contents" }} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(null)}>
      <button
        ref={row}
        className={`mi ${open ? "open" : ""}`}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={!!open}
        tabIndex={-1}
        onMouseMove={(e) => document.activeElement !== e.currentTarget && (e.currentTarget.focus(), setOpen({ key: false }))}
        onClick={() => setOpen({ key: false })}
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          setOpen({ key: true });
        }}
      >
        <span className="ck" />
        <span>{label}</span>
        <span className="val">{value}</span>
        <Icon name="chevR" className="sm" />
      </button>
      {open && (
        <div
          className="vmenu"
          role="menu"
          aria-label={title}
          tabIndex={-1}
          ref={sub}
          style={at ? { left: at.left, top: at.top } : { visibility: "hidden", left: 0, top: 0 }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              return back();
            }
            menuKeys(e, sub.current, back);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** A menu item: an icon or a check, its words (and a line under them), a value or a shortcut at its right. */
export function MenuItem({ icon, checked, label, desc, value, kbd, disabled, onClick }: {
  icon?: string;
  checked?: boolean;
  label: string;
  desc?: string;
  value?: string;
  kbd?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="mi"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      tabIndex={-1}
      disabled={disabled}
      onMouseMove={(e) => e.currentTarget.focus()}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} /> : <span className="ck">{checked && <Icon name="check" className="sm" />}</span>}
      {desc ? (
        <span className="two">
          {label}
          <span>{desc}</span>
        </span>
      ) : (
        <span>{label}</span>
      )}
      {value && <span className="val">{value}</span>}
      {kbd && <span className="kbd">{kbd}</span>}
    </button>
  );
}

const modes: PermissionMode[] = ["manual", "accept-edits", "bypass-permissions"];

/** How much finx may do without asking (the approval mode), named as it is. */
function PermissionPicker({ value, onChange }: { value: PermissionMode; onChange: (m: PermissionMode) => void }) {
  const { t } = useTranslation("session");
  return (
    <MenuButton className="mb" title={t("composer.permission")} label={<><Icon name="shield" /><span className="lbl">{permissionTitle(value)}</span></>}>
      {(close) =>
        modes.map((m) => (
          <MenuItem key={m} checked={m === value} label={permissionTitle(m)} desc={permissionDesc(m)} onClick={() => (close(), onChange(m))} />
        ))
      }
    </MenuButton>
  );
}

const allLevels: ThinkingLevel[] = ["off", "low", "medium", "high", "max"];

/**
 * The model and how hard it thinks, as one button ("DeepSeek Flash 适中").
 * Its menu is the models (their provider at the right, or that its key is
 * missing), then, when the model can think, one row for the thinking level
 * — the levels the model supports — which opens its own menu. Choosing a
 * model whose key is missing asks for the key (§8.4).
 */
function ModelPicker({ settings: { model, thinking, models, onModel, onThinking } }: { settings: Settings }) {
  const { t } = useTranslation("session");
  const current = model ?? models.defaults?.model ?? models.models[0]?.id ?? null;
  const entry = models.models.find((m) => m.id === current);
  const reasoning = entry?.reasoning ?? true;
  const levels = entry ? entry.thinking_levels.filter((l) => l !== "minimal") : allLevels;
  const providerName = (id: string) => models.providers.find((p) => p.id === id)?.name ?? id;
  const choose = (id: string, provider: string, available: boolean) => {
    onModel(id);
    if (!available) window.dispatchEvent(new CustomEvent(keyEvent, { detail: provider }));
  };
  return (
    <MenuButton
      className="mb"
      align="right"
      title={t("composer.model")}
      label={
        <>
          <span className="lbl strong">{current ? modelTitle(current, models) : t("composer.model")}</span>
          {reasoning && <span className="sub">{thinkingTitle(thinking)}</span>}
        </>
      }
    >
      {(close) => (
        <>
          {models.models.map((m) => (
            <MenuItem
              key={m.id}
              checked={m.id === current}
              label={m.name}
              value={m.available ? providerName(m.provider) : t("composer.noKey")}
              onClick={() => (close(), choose(m.id, m.provider, m.available))}
            />
          ))}
          {reasoning && (
            <>
              <div className="msep" role="separator" />
              <SubMenuItem label={t("composer.thinking")} value={thinkingTitle(thinking)} title={t("composer.thinking")}>
                {levels.map((l) => (
                  <MenuItem key={l} checked={l === thinking} label={thinkingTitle(l)} onClick={() => (close(), onThinking(l))} />
                ))}
              </SubMenuItem>
            </>
          )}
        </>
      )}
    </MenuButton>
  );
}

/** Where a new session works: the last projects, or a folder picked from the system's dialog. */
function ProjectPicker({ place: { cwd: value, names, recent, onCwd: onChange, onPick } }: { place: Place }) {
  const { t } = useTranslation("session");
  const home = window.finx?.home ?? "";
  // A folder just picked is on the list too, first, until a session in it makes it a recent one.
  const list = value && !recent.includes(value) ? [value, ...recent] : recent;
  return (
    <MenuButton className="mb" title={t("new.project")} label={<><Icon name="folder" /><span className="lbl">{value ? (names.get(value) ?? value) : t("new.project")}</span></>}>
      {(close) => (
        <>
          {list.map((p) => (
            <MenuItem key={p} checked={p === value} label={names.get(p) ?? p} desc={homePath(p, home)} onClick={() => (close(), onChange(p))} />
          ))}
          {list.length > 0 && <div className="msep" role="separator" />}
          <MenuItem icon="folderPlus" label={t("new.chooseFolder")} onClick={() => (close(), onPick())} />
        </>
      )}
    </MenuButton>
  );
}

/** Where a new session runs: this computer for now; the cloud comes later. */
function EnvironmentPicker() {
  const { t } = useTranslation("session");
  return (
    <MenuButton className="mb" title={t("new.environment")} label={<><Icon name="laptop" /><span className="lbl">{t("new.local")}</span></>}>
      {(close) => (
        <>
          <MenuItem checked label={t("new.local")} desc={t("new.localDesc")} onClick={close} />
          <MenuItem checked={false} disabled label={t("new.cloud")} desc={t("new.cloudSoon")} onClick={close} />
        </>
      )}
    </MenuButton>
  );
}
