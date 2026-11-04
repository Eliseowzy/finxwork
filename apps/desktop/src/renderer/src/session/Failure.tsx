import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { SessionView } from "@finx/client";
import type { ErrorInfo, ModelsListResult } from "@finx/protocol";
import { keyEvent } from "../composer/KeySetup";
import { MenuButton, MenuItem, SubMenuItem } from "../composer/Composer";
import { ModelList } from "../composer/ModelList";
import { failureAdvice, failureTitle, modelTitle } from "../format";
import { Icon, type IconName } from "../icons";
import { Brand } from "../settings/ProviderConnections";
import { useNow, useStore } from "../store";

// A task's failure, as one row: the provider's mark with a badge in the tone
// of what the failure asks of the owner, what happened, and one way out; the
// other ways and the provider's own words in a menu. The same row counts
// down while finx retries by itself.

/** What a failure asks: set something up, wait it out (finx retries these), or change the request. */
type Tone = "setup" | "wait" | "fail";
const tones: Record<string, Tone> = {
  auth: "setup",
  quota_exceeded: "setup",
  context_overflow: "setup",
  rate_limited: "wait",
  overloaded: "wait",
  server: "wait",
  network: "wait",
  timeout: "wait",
};
const toneOf = (kind: string): Tone => tones[kind] ?? "fail";
const badges: Record<Tone, IconName> = { setup: "info", wait: "clock", fail: "x" };

/** Sessions that compacted from a failure's card and go on once the compaction ends: asked, then running. */
const resuming = new Map<string, "asked" | "running">();

/** Goes on with a session's task once the compaction its failure card asked for has ended. */
export function useResumeAfterCompact(sessionId: string, view: SessionView) {
  const st = useStore();
  const live = view.live !== null;
  useEffect(() => {
    const state = resuming.get(sessionId);
    if (live && state === "asked") resuming.set(sessionId, "running");
    if (!live && state === "running") {
      resuming.delete(sessionId);
      void st.op(sessionId, { type: "continue" });
    }
  }, [sessionId, live]);
}

/** The provider of a session's model, as `models/list` names it. A bot's session is not in the
 * session list: its page gives the model. */
function useProvider(sessionId: string, given?: string) {
  const st = useStore();
  const model = given ?? st.sessions.find((s) => s.session_id === sessionId)?.model ?? undefined;
  const id = model?.split("/")[0] ?? "";
  const name = st.models.providers.find((p) => p.id === id)?.name ?? id;
  const ready = st.models.models.find((m) => m.id === model)?.available ?? false;
  return { model, id, name, ready };
}

function Avatar({ provider, name, tone, kind }: { provider: string; name: string; tone: Tone; kind: string }) {
  return (
    <span className="fc-av">
      {provider ? <Brand id={provider} name={name} /> : <Icon name="sparkle" />}
      <span className="fc-badge">
        <i>
          <Icon name={kind === "auth" ? "key" : badges[tone]} />
        </i>
      </span>
    </span>
  );
}

/** The models to switch to, as a submenu: those that can be used, and the current one (which, without a key, asks for it). */
function ModelItems({ current, models, onPick }: { current?: string; models: ModelsListResult; onPick: (id: string, provider: string, available: boolean) => void }) {
  const { t } = useTranslation("session");
  return (
    <SubMenuItem label={t("chat.switchModel")} value={current ? modelTitle(current, models) : ""} title={t("chat.switchModel")}>
      <ModelList models={models} current={current} onPick={(m) => onPick(m.id, m.provider, m.available)} />
    </SubMenuItem>
  );
}

/**
 * The session's current failure, with its way out. Background tasks the failure did not stop are
 * told of, with a way to stop them: they go on, with the same model, until they end by themselves.
 */
export function FailureCard({ error, working, sessionId, model }: { error?: ErrorInfo; working: number; sessionId: string; model?: string }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const kind = error?.kind ?? "unknown";
  const tone = toneOf(kind);
  const provider = useProvider(sessionId, model);
  const [open, setOpen] = useState(false);
  const retry = () => st.op(sessionId, { type: "continue" });
  const askKey = (id = provider.id) => window.dispatchEvent(new CustomEvent(keyEvent, { detail: id }));

  // Without a key: once the model has one (set here, or by switching to a model that has one), go on.
  const ready = useRef(provider.ready);
  useEffect(() => {
    const was = ready.current;
    ready.current = provider.ready;
    if (kind === "auth" && !was && provider.ready) void retry();
  }, [provider.ready, provider.model]);

  const pick = async (id: string, of: string, available: boolean) => {
    if (!(await st.op(sessionId, { type: "set_model", model: id }))) return;
    if (!available) askKey(of);
    else if (kind !== "auth") void retry();
  };
  const compact = async () => {
    resuming.set(sessionId, "asked");
    if (!(await st.op(sessionId, { type: "compact" }))) resuming.delete(sessionId);
  };
  const copy = () => error?.message && navigator.clipboard.writeText(error.message).then(() => st.show(t("chat.copiedError")));

  const main =
    kind === "auth" ? (
      <button className="btn sm primary" onClick={() => askKey()}>
        <Icon name="key" className="sm" />
        {t("chat.setKey")}
      </button>
    ) : kind === "context_overflow" ? (
      <button className="btn sm primary" onClick={compact}>
        {t("chat.compact")}
      </button>
    ) : (
      <button className="btn sm primary" onClick={retry}>
        <Icon name="retry" className="sm" />
        {t("chat.retry")}
      </button>
    );
  const retryIsMain = kind !== "auth" && kind !== "context_overflow";
  return (
    <div className="fail-wrap">
      <div className={`fcard f-${tone}`} role="alert">
        <Avatar provider={provider.id} name={provider.name} tone={tone} kind={kind} />
        <div className="fc-tx">
          <b>{t(`fail.${kind}`, { provider: provider.name || t("fail.theProvider"), defaultValue: t("fail.unknown") })}</b>
          <span>
            {failureAdvice(kind, error?.retryable ?? false)}
            {working > 0 && ` ${t("fail.working", { count: working })}`}
          </span>
        </div>
        <div className="fc-side">
          {working > 0 && (
            <button className="btn sm" onClick={() => st.op(sessionId, { type: "interrupt" })}>
              {t("fail.stopWorking")}
            </button>
          )}
          {main}
          <MenuButton className="fc-more" align="right" title={t("chat.more")} label={<Icon name="more" />}>
            {(close) => (
              <>
                <ModelItems current={provider.model} models={st.models} onPick={(id, of, available) => (close(), void pick(id, of, available))} />
                {!retryIsMain && <MenuItem icon="retry" label={t("chat.retry")} onClick={() => (close(), void retry())} />}
                {error?.message && (
                  <>
                    <div className="msep" role="separator" />
                    <MenuItem icon="chevR" label={open ? t("chat.hideError") : t("chat.showError")} onClick={() => (close(), setOpen(!open))} />
                    <MenuItem icon="copy" label={t("chat.copyError")} onClick={() => (close(), void copy())} />
                  </>
                )}
              </>
            )}
          </MenuButton>
        </div>
      </div>
      {open && <div className="fc-raw sel-text">{error?.message}</div>}
    </div>
  );
}

/** A failure the conversation went on from: one quiet line, its message behind it. */
export function PastFailure({ error }: { error?: ErrorInfo }) {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const kind = error?.kind ?? "unknown";
  return (
    <div className="fail-wrap">
      <button className={`fpast f-${toneOf(kind)}`} aria-expanded={error?.message ? open : undefined} onClick={() => error?.message && setOpen(!open)}>
        <i />
        <span>{t("chat.failedPast", { title: failureTitle(kind) })}</span>
        {error?.message && <Icon name="chevR" className={`sm chev ${open ? "open" : ""}`} />}
      </button>
      {open && <div className="fc-raw sel-text">{error?.message}</div>}
    </div>
  );
}

/** finx retrying a model request by itself: the same row, counting down to the next attempt. */
export function RetryCard({ retry, sessionId }: { retry: NonNullable<NonNullable<SessionView["live"]>["retry"]>; sessionId: string }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const now = useNow(1000).getTime();
  const provider = useProvider(sessionId);
  const kind = retry.error.kind;
  const left = Math.max(0, retry.at + retry.delay_ms - now);
  // Drawn by the stylesheet from where each wait stands when it is first shown, so it drains smoothly.
  const bar = useMemo(() => ({ from: retry.delay_ms > 0 ? left / retry.delay_ms : 0, ms: left }), [retry.attempt, retry.at]);
  return (
    <div className="fail-wrap">
      <div className="fcard f-wait" role="status">
        <Avatar provider={provider.id} name={provider.name} tone="wait" kind={kind} />
        <div className="fc-tx">
          <b>{t(`fail.${kind}`, { provider: provider.name || t("fail.theProvider"), defaultValue: t("fail.unknown") })}</b>
          <span>{left > 0 ? t("chat.retryIn", { seconds: Math.ceil(left / 1000), attempt: retry.attempt }) : t("chat.retrying", { attempt: retry.attempt })}</span>
        </div>
        <div className="fc-side">
          <button className="btn sm" onClick={() => st.op(sessionId, { type: "interrupt" })}>
            {t("chat.stopRetry")}
          </button>
        </div>
        <span className="fc-clip" aria-hidden="true">
          <i key={`${retry.attempt}:${retry.at}`} style={{ "--from": bar.from, animationDuration: `${bar.ms}ms` } as CSSProperties} />
        </span>
      </div>
    </div>
  );
}
