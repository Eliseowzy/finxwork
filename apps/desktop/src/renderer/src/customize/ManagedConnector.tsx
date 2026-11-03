import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CatalogConnector } from "../../../shared/catalog";
import type { McpChangedParams } from "@finx/protocol";
import { Dialog } from "../components";
import { errorText, useStore } from "../store";
import { catalogLogo, ServerTile } from "./parts";
import type { Customize } from "./useCustomize";

type Step = "intro" | "installing" | "authorizing" | "ready" | "failed";

/** The same sheet serves curated CLI manifests; finx owns binaries and authorization. */
export function ManagedConnector({ c, catalog, onClose, onDone }: {
  c: Customize; catalog: CatalogConnector; onClose: () => void; onDone: () => void;
}) {
  const { t } = useTranslation("customize");
  const rpc = useStore().rpc;
  const [step, setStep] = useState<Step>("intro");
  const [failure, setFailure] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const alive = useRef(true);
  const active = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop.current?.();
      if (active.current) void rpc?.request("mcp/login_cancel", { name: catalog.id }).catch(() => {});
    };
  }, [rpc, catalog.id]);

  const close = () => {
    // Downloading can finish into the cache; cancel any authorization on closing.
    alive.current = false;
    stop.current?.();
    if (active.current) void rpc?.request("mcp/login_cancel", { name: catalog.id }).catch(() => {});
    onClose();
  };

  const start = async () => {
    if (!rpc || active.current) return;
    active.current = true;
    setFailure(null);
    setUrl(null);
    setStep("installing");
    try {
      const installed = await rpc.request("connectors/install", { id: catalog.managed! });
      if (!alive.current) return;
      const existing = c.servers.find((s) => s.name === catalog.id);
      if (existing && existing.connector !== catalog.managed) throw new Error(t("managed.nameConflict"));
      if (!existing) await c.saveServer("user", catalog.id, { ...installed.server }, []);
      if (!alive.current) return;
      setStep("authorizing");
      // Subscribe BEFORE login: a fast callback may arrive before the RPC result.
      const events = new Map<string, McpChangedParams>();
      let loginId: string | null = null;
      let finish!: (p: McpChangedParams) => void;
      const ended = new Promise<McpChangedParams>((resolve) => { finish = resolve; });
      const showURL = (url: string) => { setUrl(url); window.finx?.openExternal(url); };
      const accept = (p: McpChangedParams) => {
        if (p.authorize_url) showURL(p.authorize_url);
        else finish(p);
      };
      const off = rpc.on("mcp/changed", (p) => {
        if (p.name !== catalog.id || !p.login_id) return;
        events.set(p.login_id, p);
        if (p.login_id === loginId) accept(p);
      });
      stop.current = () => { off(); finish({ name: catalog.id, login_error: t("managed.cancelled") }); };
      try {
        const login = await rpc.request("mcp/login", { name: catalog.id, ...(c.cwd ? { cwd: c.cwd } : {}) });
        loginId = login.login_id;
        if (!alive.current) {
          await rpc.request("mcp/login_cancel", { name: catalog.id });
          return;
        }
        const early = events.get(loginId);
        if (early) accept(early);
        else showURL(login.authorize_url);
        const result = await ended;
        if (!alive.current) return;
        if (result.login_error) throw new Error(result.login_error);
        const checked = await c.check(catalog.id);
        if (checked?.server.status.state !== "ok") throw new Error(checked?.server.status.error || t("managed.checkFailed"));
        if (alive.current) setStep("ready");
      } finally { off(); stop.current = null; }
    } catch (e) {
      if (alive.current) { setFailure(errorText(e)); setStep("failed"); }
    } finally { active.current = false; }
  };
  const busy = step === "installing" || step === "authorizing";
  return (
    <Dialog label={t("managed.title", { name: catalog.name })} width={480} className="cz-sheet cz-add" onClose={close}>
      <h3>{t("managed.title", { name: catalog.name })}</h3>
      <div className="cz-managed">
        <div className="cz-summary"><ServerTile name={catalog.name} mono={catalog.mono} icon={catalogLogo(catalog)} /><div><strong>{catalog.name}</strong><p>{t("managed.installHint")}</p></div></div>
        <p>{t("managed.permissions", { name: catalog.name })}</p>
        <p className="hint">{t(`managed.hints.${catalog.id}`, { defaultValue: t("managed.authorizeHint", { name: catalog.name }) })}</p>
        {step !== "intro" && <div role="status" aria-live="polite" className="cz-managed-status">
          {busy && <span className="mini-spin" />}{t(`managed.steps.${step}`)}
        </div>}
        {failure && <p className="cz-managed-error" role="alert">{failure}</p>}
        {step === "authorizing" && url && <div className="acts">
          <button className="link" data-authorize={url} onClick={() => window.finx?.openExternal(url)}>{t("managed.openBrowser")}</button>
          <button className="link" onClick={() => void navigator.clipboard?.writeText(url)}>{t("addc.copyLink")}</button>
        </div>}
      </div>
      <div className="sheet-foot">
        {step !== "ready" && <button className="btn" onClick={close}>{t(busy ? "managed.cancel" : "managed.later")}</button>}
        {!busy && <button className="btn primary" onClick={step === "ready" ? onDone : () => void start()}>{t(step === "ready" ? "managed.done" : step === "failed" ? "retry" : "managed.install")}</button>}
      </div>
    </Dialog>
  );
}
