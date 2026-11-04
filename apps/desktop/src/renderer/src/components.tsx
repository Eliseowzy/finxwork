import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { displayTitle, type ListSession } from "@finx/client";
import type { SessionState } from "@finx/protocol";
import { Icon } from "./icons";
import { layoutOf, setSidebar } from "./layout";
import { useOverlay } from "./overlays";
import { useStore } from "./store";

/** A session's title, edited in place: ↩ or leaving the field keeps it (`end` gets the text), Esc puts it back (`end` gets null). */
export function RenameField({ s, className, end }: { s: ListSession; className: string; end: (title: string | null) => void }) {
  const { t } = useTranslation("common");
  const [value, setValue] = useState(displayTitle(s));
  const done = useRef(false);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    end(keep ? value : null);
  };
  return (
    <input
      className={className}
      aria-label={t("sessionMenu.renameLabel")}
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** A session's state as a small dot: orange waits for the owner, red failed, green runs. */
export function StatusDot({ state }: { state: SessionState }) {
  const { t } = useTranslation("common");
  const c = state === "awaiting_approval" ? "w" : state === "failed" ? "c" : state === "running" ? "r" : "i";
  return <span className={`sdot ${c}`} role="img" aria-label={t(`state.${state}`)} title={t(`state.${state}`)} />;
}

/** The window's title bar area when the sidebar is hidden: room for the traffic lights, and the sidebar toggle. */
export function SidebarToggle() {
  const st = useStore();
  const { t } = useTranslation("common");
  if (layoutOf(st).sidebar !== "hidden") return null;
  return (
    <>
      <span style={{ width: "calc(var(--lights) - 30px)", flex: "none" }} />
      <button className="tb" onClick={() => setSidebar(st, true)} aria-label={t("window.showSidebar")} title={t("window.showSidebar")}>
        <Icon name="sidebar" className="panel" />
      </button>
    </>
  );
}

export function ToastView() {
  const st = useStore();
  const { t } = useTranslation("common");
  if (!st.toast) return null;
  const toast = st.toast;
  return (
    <div className={`toast ${toast.bad ? "bad" : ""}`} role="status">
      <Icon name={toast.bad ? "warn" : "check"} />
      <span>{toast.text}</span>
      {toast.undo && (
        <button className="btn sm" onClick={() => (st.set({ toast: null }), toast.undo?.())}>{t("window.undo")}</button>
      )}
    </div>
  );
}

/**
 * A modal dialog, the platform's own (`<dialog>` shown modal): centred over
 * the window, which is blurred behind it and out of reach until it closes.
 * Escape or a click outside closes it, and Escape goes no further (the
 * settings window closes on an Escape nothing else took).
 */
export function Dialog({ label, width, className, onClose, children }: { label: string; width: number; className?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useOverlay();
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={className ? `sheet ${className}` : "sheet"}
      aria-label={label}
      style={{ width }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        onClose();
      }}
      onCancel={(e) => (e.preventDefault(), onClose())}
      // Only the backdrop is the dialog itself; its content is inside .sheet-in.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="sheet-in">{children}</div>
    </dialog>
  );
}

/** The sheet the window shows, if any: a confirmation. */
export function SheetHost() {
  const st = useStore();
  const { t } = useTranslation("common");
  const sheet = st.sheet;
  if (!sheet) return null;
  const close = () => st.set({ sheet: null });
  return (
    <Dialog label={sheet.title} width={420} onClose={close}>
      <h3>{sheet.title}</h3>
      <p className="sub">{sheet.message}</p>
      <div className="sheet-foot">
        <button className="btn" onClick={close}>{sheet.cancel ?? t("sheet.cancel")}</button>
        <button
          className="btn primary danger"
          onClick={async () => {
            close();
            await st.run(sheet.run, sheet.done);
          }}
        >
          {sheet.button}
        </button>
      </div>
    </Dialog>
  );
}
