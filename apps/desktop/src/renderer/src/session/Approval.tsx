import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { approvalPreview, argsOf, callTarget, describe, pendingApproval, toolObject, type ApprovalPreview, type SessionView } from "@finx/client";
import type { ApprovalDecision, CellChange, Impact, SheetOp, SiteGrant } from "@finx/protocol";
import { pageCommand } from "../commands";
import { APP_ORIGIN, useDesktopApp, useDesktopStatus } from "../desktopControl";
import { toolDo } from "../format";
import { Icon, Mark } from "../icons";
import { SiteIcon, siteOrigin } from "../siteIcon";
import { useStore } from "../store";
import { bringBrowserBack } from "./browserPanel";
import { Code } from "./Code";
import { handoffOf, revealYours, useYourBrowser } from "./Yours";

/**
 * A tool call waiting for the owner (Op::Approval), the session's own or a
 * sub-agent's, which says who asks. Popped up right above the composer in its shape: what finx wants to do and why it asks, the
 * command or the change itself, and the answers as buttons, one click each.
 * Deny opens a line for why, which goes back to the model; stopping the
 * whole task is the composer's Stop. Keys: ⌘↩ (the menu's Approve) allows
 * once from anywhere; outside the composer ↩ allows, 2 allows for the
 * session, Esc (or 3) denies. Several waiting are answered in order.
 * A website asks one question, the site by name (SiteApproval): once, always
 * this site, or always every site, both kept in ~/.finx/config.toml; 2
 * picks "always this site". A desktop call offers each proposed app grant as
 * its own button, names the app by its name and icon, and says so when
 * FinxWork lacks the system permission the call needs.
 */
export function Approval({ sessionId, view }: { sessionId: string; view: SessionView }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const { approval: a, agent } = pendingApproval(view)!;
  // A sub-agent's call is in its own session.
  const live = (agent?.view ?? view).live!;
  // What the call runs: a browser's or computer use's tool comes through call_tool.
  const target = callTarget(a.name, a.args);
  const tool = live.tools.find((x) => x.call_id === a.call_id) ?? { ...describe(a.name, argsOf(a.args), view.info.cwd), name: a.name };
  const preview = approvalPreview(target.name, target.args, a.summary);
  const [denying, setDenying] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  // "Always": the chosen app grant also goes into ~/.finx/config.toml.
  const [remember, setRemember] = useState(false);
  const [sheetImpact, setSheetImpact] = useState<Impact | "loading" | null>(null);
  // The workbook's file name: the agent may name it by its id.
  const [sheetFile, setSheetFile] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // A page handed to the person (browser_wait with user): they went to it, and may say they are done.
  const [went, setWent] = useState(false);
  const yourBrowser = useYourBrowser();
  const sheetArgs = target.name === "doc_edit" ? target.args as { doc?: unknown; ops?: unknown } : null;

  useEffect(() => {
    if (!sheetArgs || !st.rpc || typeof sheetArgs.doc !== "string" || !Array.isArray(sheetArgs.ops)) return;
    let live = true;
    setSheetImpact("loading");
    void (async () => {
      try {
        const ref = /^[0-9a-f]{16}$/.test(sheetArgs.doc as string) ? { doc_id: sheetArgs.doc as string } : { path: sheetArgs.doc as string };
        const opened = await st.rpc!.request("doc/open", { session_id: sessionId, ...ref });
        const result = await st.rpc!.request("doc/apply", {
          session_id: sessionId,
          doc_id: opened.info.doc_id,
          ops: sheetArgs.ops as SheetOp[],
          base_revision: opened.info.revision,
          preview: true,
        });
        if (live) {
          setSheetImpact(result.impact);
          setSheetFile(opened.info.path.split(/[\\/]/).pop() ?? null);
        }
      } catch {
        if (live) setSheetImpact(null);
      }
    })();
    return () => { live = false; };
  }, [a.call_id, sessionId, st.rpc]);

  const give = async (decision: ApprovalDecision) => {
    if (busy) return;
    setBusy(true);
    await st.op(sessionId, agent ? { type: "agent_approval", agent: agent.id, call_id: a.call_id, decision } : { type: "approval", call_id: a.call_id, decision });
    setBusy(false);
  };
  const deny = () => give({ type: "deny", feedback: feedback.trim() || undefined });

  // The keys work unless the person types elsewhere or another layer is open.
  const grants = a.proposed_grants ?? [];
  const appKey = grants.find((g) => g.origin.startsWith(APP_ORIGIN))?.origin.slice(APP_ORIGIN.length);
  const desktopApp = useDesktopApp(appKey);
  // Screenshots need Screen Recording; reading and acting, Accessibility.
  const cua = target.name.startsWith("cua_");
  const { status } = useDesktopStatus(undefined, cua);
  const permission = target.name === "cua_screenshot" ? "screen" : "accessibility";
  const missing = cua && status && status[permission] !== "granted" && status[permission] !== "unsupported";
  // A website: its grants are the site and every site, never an app (D-221).
  const site = grants.length > 0 && !grants.some((g) => g.origin.startsWith(APP_ORIGIN));
  const keys = useRef({ give, denying, blocked: false, grants: false, site: false });
  keys.current = { give, denying, blocked: st.sheet !== null || st.searching, grants: grants.length > 0, site };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (k.blocked || k.denying || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")) return;
      if (e.key === "Enter" || e.key === "1") k.give({ type: "approve" });
      else if (e.key === "2") k.give({ type: "approve_for_session", grant: k.grants ? 0 : undefined, persist: k.site || undefined });
      else if (e.key === "Escape" || e.key === "3") setDenying(true);
      else return;
      e.preventDefault();
    };
    const onCommand = (e: Event) => (e as CustomEvent).detail === "approve" && keys.current.give({ type: "approve" });
    document.addEventListener("keydown", onKey);
    window.addEventListener(pageCommand, onCommand);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(pageCommand, onCommand);
    };
  }, []);
  useEffect(() => {
    if (denying) field.current?.focus();
  }, [denying]);

  const question = sheetArgs ? t("approval.editWorkbook", { name: sheetFile ?? String(sheetArgs.doc ?? "") }) : tool.category === "execute" ? t("approval.runCommand") : t("approval.useTool", { verb: toolDo(tool.category), object: toolObject(tool) });
  const rule = a.proposed_rule?.prefix.join(" ");
  const denyField = (
    <>
      <input
        ref={field}
        className="field"
        placeholder={t("approval.feedback")}
        aria-label={t("approval.feedback")}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") (e.preventDefault(), deny());
          else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setDenying(false));
        }}
      />
      <button className="btn" onClick={() => setDenying(false)}>{t("approval.cancel")}</button>
      <button className="btn danger" disabled={busy} onClick={deny}>
        {t("approval.deny")}
        <span className="kret">↩</span>
      </button>
    </>
  );
  const queue = live.approvals.length > 1 && <span className="qx-tag">{t("approval.queue", { n: 1, total: live.approvals.length })}</span>;
  const who = agent && <span className="appr-who" title={agent.name}>{t("approval.agent", { name: agent.description || agent.name })}</span>;
  const handoff = handoffOf(a);
  if (handoff !== null) {
    const name = a.own_browser ? yourBrowser.name : t("browser.builtIn");
    const go = () => {
      setWent(true);
      if (a.own_browser) void revealYours(st, yourBrowser.browser, sessionId);
      else {
        bringBrowserBack(sessionId);
        st.set({ browser: true, background: false, files: false, filesMax: false });
      }
    };
    return (
      <div className="appr" role="region" aria-label={t("approval.label")}>
        <div className="appr-h">
          <Mark size={16} />
          <b>{t("yours.handoff.title", { name })}</b>
          {who}
        </div>
        <div className="appr-site">
          <span className="sel-text">{handoff}</span>
        </div>
        <div className="appr-f">
          {denying ? (
            denyField
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={() => setDenying(true)}>{t("yours.handoff.skip")}</button>
              <span className="appr-sp" />
              {went && <button className="btn" onClick={go}>{t("yours.handoff.again")}</button>}
              {went ? (
                <button className="btn primary" disabled={busy} onClick={() => give({ type: "approve" })}>
                  {t("yours.handoff.done")}
                  <span className="kret">⌘↩</span>
                </button>
              ) : (
                <button className="btn primary" onClick={go}>{t("yours.handoff.go", { name })}</button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }
  if (site) {
    const origin = grants[0].origin;
    const every = grants.findIndex((g) => g.origin === "*");
    // In the user's own browser the accounts are real: the question says so, and in bypass why
    // it is asked at all (connectors-entry-design §3.4).
    const own = a.own_browser === true;
    const bypass = view.info.permission_mode === "bypass-permissions";
    const opening = target.name === "browser_navigate" || target.name === "browser_tabs";
    const url = typeof target.args.url === "string" ? (target.args.url as string) : a.summary;
    return (
      <div className="appr" role="region" aria-label={t("approval.label")}>
        <div className="appr-h">
          <Mark size={16} />
          <b title={origin}>
            {t(!own ? "approval.siteQuestion" : opening ? "approval.siteQuestionYours" : "approval.siteActYours", { site: hostOf(origin) })}
          </b>
          {who}
          {queue}
        </div>
        <div className="appr-site">
          {own && <span>{t(bypass ? "approval.siteYoursBypass" : "approval.siteYours")}</span>}
          <span className="appr-url">
            <SiteIcon origin={siteOrigin(origin)} fallback={<Icon name="globe" />} />
            <code className="sel-text" title={url}>{url}</code>
          </span>
        </div>
        <div className="appr-f">
          {denying ? (
            denyField
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={() => setDenying(true)}>{t("approval.denyWhy")}</button>
              <span className="appr-sp" />
              {every >= 0 && (
                <button className="btn" disabled={busy} title={t("approval.siteEveryDesc")} onClick={() => give({ type: "approve_for_session", grant: every, persist: true })}>
                  {t("approval.siteEvery")}
                </button>
              )}
              <button className="btn" disabled={busy} title={t("approval.siteAlwaysDesc")} onClick={() => give({ type: "approve_for_session", grant: 0, persist: true })}>
                {t("approval.siteAlways")}
              </button>
              <button className="btn primary" disabled={busy} onClick={() => give({ type: "approve" })}>
                {t("approval.siteOnce")}
                <span className="kret">⌘↩</span>
              </button>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="appr" role="region" aria-label={t("approval.label")}>
      <div className="appr-h">
        <Mark size={16} />
        <b>{question}</b>
        {desktopApp && (
          <span className="appr-app" title={desktopApp.key}>
            {desktopApp.icon && <img src={desktopApp.icon} alt="" />}
            {desktopApp.name}
          </span>
        )}
        {a.reason && <span className="why" title={a.reason}>{a.reason}</span>}
        {who}
        {queue}
      </div>
      {sheetArgs ? <SheetApproval impact={sheetImpact} ops={Array.isArray(sheetArgs.ops) ? sheetArgs.ops as SheetOp[] : []} /> : <Preview p={preview} />}
      {missing && (
        <div className="appr-warn" role="alert">
          <span>{t(permission === "screen" ? "approval.desktopNoScreen" : "approval.desktopNoAccessibility")}</span>
          <button className="btn" onClick={() => window.finx?.requestDesktopPermission(permission)}>{t("approval.desktopGrant")}</button>
        </div>
      )}
      <div className="appr-f">
        {denying ? (
          denyField
        ) : (
          <>
            <button className="btn" disabled={busy} onClick={() => setDenying(true)}>{t("approval.denyWhy")}</button>
            <span className="appr-sp" />
            {grants.length > 0 && (
              <label className="appr-keep" title={t("approval.rememberDesc")}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                {t("approval.remember")}
              </label>
            )}
            {grants.length > 0 ? (
              grants.map((g, i) => (
                <button key={i} className="btn" disabled={busy} title={t("approval.grantAppDesc")} onClick={() => give({ type: "approve_for_session", grant: i, persist: remember || undefined })}>
                  {grantLabel(g, t, desktopApp?.name)}
                </button>
              ))
            ) : (
              <button className="btn" disabled={busy} title={rule ? t("approval.sessionRule", { rule }) : t("approval.sessionDesc")} onClick={() => give({ type: "approve_for_session" })}>
                {t("approval.session")}
              </button>
            )}
            <button className="btn primary" disabled={busy} onClick={() => give({ type: "approve" })}>
              {t("approval.once")}
              <span className="kret">⌘↩</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

type T = ReturnType<typeof useTranslation<"session">>["t"];

/** A desktop app's grant (`app://<bundle id>`) as a button: the app by its name once known, else its bundle id. One grant allows the app, reading and acting alike. */
function grantLabel(g: SiteGrant, t: T, appName?: string): string {
  return t("approval.grantApp", { app: appName ?? g.origin.slice(APP_ORIGIN.length) });
}

/** A site as people read it: the host, with the scheme only when it is not https. */
function hostOf(origin: string): string {
  return origin.replace(/^https:\/\//, "");
}

function SheetApproval({ impact, ops }: { impact: Impact | "loading" | null; ops: SheetOp[] }) {
  const { t } = useTranslation("session");
  const changes: CellChange[] = impact && impact !== "loading" ? impact.edited : ops.map((op) => ({
    sheet: op.sheet,
    cell: "cell" in op ? op.cell : op.range,
    before_text: "",
    after_text: op.op === "set_formula" ? op.formula : op.op === "set_value" ? String(op.value) : t("approval.cleared"),
    before: null,
    after: null,
  }));
  const outputs = impact && impact !== "loading" ? impact.key_outputs ?? [] : [];
  const pct = (row: Impact["edited"][number]) => {
    const a = row.before?.type === "number" ? row.before.value : null;
    const b = row.after?.type === "number" ? row.after.value : null;
    return typeof a === "number" && typeof b === "number" && a !== 0 ? ` (${((b - a) / Math.abs(a) * 100).toFixed(1)}%)` : "";
  };
  const table = (title: string, rows: CellChange[], showPercent = false) => (
    <div className="appr-sheet-table">
      <b>{title}</b>
      {rows.slice(0, 5).map((row, i) => (
        <div key={`${row.sheet}!${row.cell}:${i}`}>
          <code>{row.sheet}!{row.cell}</code>
          <span>{row.label ?? ""}</span>
          <span>{row.before_text ? `${row.before_text} → ` : ""}{row.after_text}{showPercent ? pct(row) : ""}</span>
        </div>
      ))}
      {rows.length > 5 && <small>{t("approval.more", { count: rows.length - 5 })}</small>}
    </div>
  );
  return (
    <div className="appr-sheet">
      {table(t("sheet.changes"), changes)}
      {sheetImpactState(impact, outputs.length) && table(t("sheet.outputs"), outputs, true)}
      {impact === "loading" && <div className="appr-sheet-loading"><span className="mini-spin" />{t("approval.calculatingImpact")}</div>}
      {impact && impact !== "loading" && (
        <div className="appr-sheet-meta">
          <span>{t("sheet.affected", { count: impact.affected_count })}</span>
          {(impact.needs_excel?.length ?? 0) > 0 && <span>{t("sheet.needsExcel", { count: impact.needs_excel!.length })}</span>}
        </div>
      )}
    </div>
  );
}

const sheetImpactState = (impact: Impact | "loading" | null, outputs: number) => impact !== "loading" && !!impact && outputs > 0;

/** The call itself: a command coloured as shell, a change as removed and added lines, or what it writes. */
function Preview({ p }: { p: ApprovalPreview }) {
  const { t } = useTranslation("session");
  switch (p.kind) {
    case "command":
      return (
        <pre className="appr-pre sel-text">
          <Code text={p.text} lang="bash" />
        </pre>
      );
    case "diff":
      return (
        <pre className="appr-pre diff sel-text">
          {p.lines.map((l, i) => (
            <span key={i} className={l.sign === "+" ? "add" : "del"}>
              {l.sign} {l.text}
            </span>
          ))}
          {p.more > 0 && <span className="more">{t("approval.more", { count: p.more })}</span>}
        </pre>
      );
    case "content":
      return (
        <pre className="appr-pre sel-text">
          {p.lines.join("\n")}
          {p.more > 0 && <span className="more">{t("approval.more", { count: p.more })}</span>}
        </pre>
      );
    case "args":
      return <pre className="appr-pre sel-text">{p.text}</pre>;
  }
}
