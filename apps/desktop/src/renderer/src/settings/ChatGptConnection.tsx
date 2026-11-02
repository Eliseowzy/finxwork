import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatGptStatus } from "@finx/protocol";
import { errorText, useStore } from "../store";
import { Brand } from "./ProviderConnections";
import { ManageModels, useModelCounts } from "./ManageModels";

/** Subscription authorization lives in the kernel and survives closing this settings window. */
export function ChatGptConnection() {
  const { t } = useTranslation("settings");
  const st = useStore();
  const call = st.call;
  const [status, setStatus] = useState<ChatGptStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [managing, setManaging] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const connection = status?.connection;
  const pending = status?.state === "pending";
  const ready = connection?.state === "ready";
  const { count, shown } = useModelCounts(connection?.provider_id);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await call("chatgpt/status", {});
      if (mounted.current && request === generation.current) setStatus(next);
    } catch (e) {
      if (mounted.current && request === generation.current) setError(errorText(e));
    }
  }, [call]);
  useEffect(() => {
    mounted.current = true;
    if (st.rpc) void refresh();
    const off = st.rpc?.on("models/changed", () => void refresh());
    return () => { mounted.current = false; generation.current++; off?.(); };
  }, [st.rpc, refresh]);
  useEffect(() => {
    if (!pending) return;
    // One request at a time; closing the window stops polling, not the kernel login.
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(() => void poll(), 700);
    };
    timer = setTimeout(() => void poll(), 700);
    return () => { stopped = true; clearTimeout(timer); };
  }, [pending, refresh]);
  const open = async (url: string) => {
    try { await window.finx?.openExternal(url); }
    catch (e) { if (mounted.current) setError(errorText(e)); }
  };
  const act = async (action: "login" | "cancel" | "logout" | "models" | "forget") => {
    setBusy(true);
    setError("");
    generation.current++;
    try {
      let next: ChatGptStatus;
      if (action === "forget") {
        await call("connections/remove", { connection_id: "chatgpt-api" });
        next = await call("chatgpt/status", {});
      } else if (action === "models") {
        await call("connections/models", { connection_id: "chatgpt-api" });
        next = await call("chatgpt/status", {});
      } else if (action === "cancel") {
        next = await call("chatgpt/cancel", { login_id: status!.login_id! });
      } else {
        next = await call(action === "login" ? "chatgpt/login" : "chatgpt/logout", {});
      }
      if (!mounted.current) return;
      generation.current++;
      setStatus(next);
      if (action === "login" && next.authorize_url) await open(next.authorize_url);
      await st.refreshModels();
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const line = pending ? t("models.chatgpt.waiting")
    : ready ? t("models.state.readyShown", { shown, count })
    : connection?.state === "needs_login" ? t("models.chatgpt.expired")
    : t("models.chatgpt.note");
  return (
    <>
      <div className="frow mrow" data-testid="chatgpt-connection">
        <Brand id="openai" name="ChatGPT" />
        <div className="ft">
          <div className="fn">ChatGPT</div>
          <div className="fdesc" aria-live="polite">{[status?.account, line].filter(Boolean).join(" · ")}</div>
        </div>
        {pending ? <>
          <button className="btn" disabled={busy || !status?.authorize_url} onClick={() => void open(status!.authorize_url!)}>{t("models.chatgpt.openBrowser")}</button>
          <button className="btn" disabled={busy} onClick={() => void act("cancel")}>{t("models.cancel")}</button>
        </> : <>
          {ready ? <button className="btn" disabled={busy} onClick={() => setManaging(true)}>{t("models.manage.open")}</button>
            : <button className="btn primary" disabled={busy || !st.rpc || !status} onClick={() => void act("login")}>{t("models.connect")}</button>}
          {connection && <button className="btn" disabled={busy} onClick={() => void act("logout")}>{t("models.disconnect")}</button>}
          {!connection && status?.account && <button className="btn" disabled={busy} onClick={() => void act("forget")}>{t("models.chatgpt.forget")}</button>}
          {connection?.state === "unavailable" && <button className="btn" disabled={busy} onClick={() => void act("models")}>{t("models.manage.refresh")}</button>}
        </>}
      </div>
      {(error || status?.message) && <p className="mrow-err" role="status">{error || status?.message}</p>}
      {managing && connection && <ManageModels source={{
        id: connection.provider_id, name: "ChatGPT", mark: <Brand id="openai" name="ChatGPT" />,
        origin: t("models.chatgpt.origin"), fetchedAt: connection.models_fetched_at,
        failure: error || undefined, refresh: () => act("models"),
      }} onClose={() => setManaging(false)} />}
    </>
  );
}
