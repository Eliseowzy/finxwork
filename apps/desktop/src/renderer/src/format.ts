import { hourMinute, isYesterday, modelName, monthDay, sameDay, weekday, withinWeek, type Bucket, type ToolView, type WorkItem, workSummary } from "@finx/client";
import type { ModelPrice, ModelSummary, ModelsListResult, PermissionMode, SessionState, ThinkingLevel } from "@finx/protocol";
import { i18n, language } from "../../shared/i18n";

// The window's words for times, states and steps, in the app's language.

const t = i18n.getFixedT(null, "common");

/** When something last changed: "15:42" today, "Yesterday", a weekday within the week, else the date. */
export function shortTime(d: Date, now: Date): string {
  if (sameDay(d, now)) return hourMinute(d);
  if (isYesterday(d, now)) return t("time.yesterday");
  if (withinWeek(d, now)) return weekday(d, language());
  return monthDay(d, language());
}

/** "just now", "12 min ago", "3 hr ago", "Yesterday 14:20", "Oct 15". */
export function agoText(d: Date, now: Date): string {
  const s = (now.getTime() - d.getTime()) / 1000;
  if (s < 60) return t("time.justNow");
  if (s < 3600) return t("time.minutesAgo", { count: Math.trunc(s / 60) });
  if (sameDay(d, now)) return t("time.hoursAgo", { count: Math.trunc(s / 3600) });
  if (isYesterday(d, now)) return `${t("time.yesterday")} ${hourMinute(d)}`;
  return monthDay(d, language());
}

/** A message's time under it: "刚刚" in its first minute, "5 分钟前", "3 小时前", "2 天前" within a week, else the date and time. */
export function messageAgo(d: Date, now: Date): string {
  const s = Math.max(0, (now.getTime() - d.getTime()) / 1000);
  if (s < 60) return t("time.justNow");
  if (s < 3600) return t("time.minutesAgo", { count: Math.trunc(s / 60) });
  if (s < 86400) return t("time.hoursAgo", { count: Math.trunc(s / 3600) });
  if (s < 7 * 86400) return t("time.daysAgo", { count: Math.trunc(s / 86400) });
  return `${monthDay(d, language())} ${hourMinute(d)}`;
}

/** How often a message's time needs redrawing: every ten seconds in its first minute (to turn from "just now" soon after it ends), then every minute, then every ten. */
export function agoInterval(d: Date): number {
  const s = (Date.now() - d.getTime()) / 1000;
  return s < 60 ? 10_000 : s < 3600 ? 60_000 : 600_000;
}

/** The session list's time: how long ago today, then "Yesterday", a weekday, or the date. */
export function listTime(d: Date, now: Date): string {
  return sameDay(d, now) ? agoText(d, now) : shortTime(d, now);
}

/** A time line before a message, only for the first one and after a pause (half an hour; Bot mode's, ten minutes): "Today 18:22". */
export function timeLine(at: Date, previous: Date | undefined, now: Date, pause = 30 * 60_000): string | null {
  if (previous && at.getTime() - previous.getTime() < pause) return null;
  const day = sameDay(at, now) ? t("time.today") : isYesterday(at, now) ? t("time.yesterday") : withinWeek(at, now) ? weekday(at, language()) : monthDay(at, language());
  return `${day} ${hourMinute(at)}`;
}

/** How long something took or has run, in its two largest units: "48 s", "2 min 14 s", "3 hr 5 min", "2 d 4 hr", "1 hr". */
export function durationText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  const part = (unit: "seconds" | "minutes" | "hours" | "days", count: number) => t(`time.${unit}`, { count });
  const pair = (big: string, small: string, rest: number) => (rest > 0 ? t("time.pair", { big, small }) : big);
  if (s < 60) return part("seconds", s);
  if (s < 3600) return pair(part("minutes", Math.trunc(s / 60)), part("seconds", s % 60), s % 60);
  if (s < 86400) return pair(part("hours", Math.trunc(s / 3600)), part("minutes", Math.trunc(s / 60) % 60), Math.trunc(s / 60) % 60);
  return pair(part("days", Math.trunc(s / 86400)), part("hours", Math.trunc(s / 3600) % 24), Math.trunc(s / 3600) % 24);
}

export function bucketTitle(b: Bucket): string {
  return t(`bucket.${b}`);
}

/** The verb for a step: "Read", "Running"; a refused one is "Denied". */
export function toolVerb(tool: ToolView): string {
  if (tool.state === "denied") return t("steps.denied.done");
  if (tool.state === "cancelled") return t("steps.cancelled");
  if (tool.state === "awaiting_approval") return t("steps.awaiting");
  const live = tool.state === "running" || tool.state === "pending" || tool.state === "streaming";
  return t(`steps.${tool.category}.${live ? "doing" : "done"}`);
}

/** A group's line: "Read 2 files, ran 3 commands", kinds in the order they first appear. */
export function workText(items: WorkItem[]): string {
  return workSummary(items).map(({ kind, count }) => t(`steps.${kind}.count`, { count })).join(t("steps.separator"));
}

/** Calls running at once, as one line: "Reading 2 files", or "Working on 3 steps" for calls of different kinds. */
export function doingText(tools: ToolView[]): string {
  const kinds = new Set(tools.map((x) => x.category));
  return kinds.size === 1 ? t(`steps.${tools[0].category}.doingCount`, { count: tools.length }) : t("steps.doingMixed", { count: tools.length });
}

/** The verb for asking to do a step: "Run", "Edit". */
export function toolDo(category: ToolView["category"]): string {
  return t(`steps.${category}.do`);
}

export function stateTitle(s: SessionState): string {
  return t(`state.${s}`);
}

export function permissionTitle(m: PermissionMode): string {
  return t(`permission.${m}.title`);
}

export function permissionDesc(m: PermissionMode): string {
  return t(`permission.${m}.desc`);
}

export function thinkingTitle(l: ThinkingLevel): string {
  return t(`thinking.${l}`);
}

/** Whether a model offers a thinking level; "default" (the provider decides) it always does. */
export function offersThinking(m: ModelSummary | undefined, l: ThinkingLevel): boolean {
  return l === "default" || !!m?.thinking_levels.includes(l);
}

/**
 * The thinking level that goes with a model (model-catalog-design §18): `current` when the model
 * offers it, else the level the model starts with (the one last chosen on it, else "default").
 * `null` is a level nobody chose. The kernel applies the same rule to a session's model switch.
 */
export function thinkingFor(m: ModelSummary | undefined, current: ThinkingLevel | null): ThinkingLevel {
  if (current && current !== "default" && offersThinking(m, current)) return current;
  return m?.default_thinking ?? "default";
}

/** A new session's level on its model: the one chosen on the page when the model offers it ("default" included), else the level the model starts with. */
export function draftThinking(m: ModelSummary | undefined, chosen: ThinkingLevel | null): ThinkingLevel {
  return chosen !== null && offersThinking(m, chosen) ? chosen : (m?.default_thinking ?? "default");
}

/** A model's name as its provider lists it, else its short reference. */
export function modelTitle(ref: string, models: ModelsListResult): string {
  const found = models.models.find((m) => m.id === ref);
  if (found) return found.name;
  return modelName(ref);
}

/** A model menu's row; `note` says why the current model is there although the menu would leave it out. */
export type MenuModel = ModelSummary & { note?: "noKey" | "hidden" | "gone" };

/** The models a model menu offers: those in the menu that can be used, and first the current one when it is not (model-catalog-design §10). */
export function menuModels(models: ModelsListResult, current?: string | null): MenuModel[] {
  const list: MenuModel[] = models.models.filter((m) => m.available && m.shown);
  if (!current || list.some((m) => m.id === current)) return list;
  const found = models.models.find((m) => m.id === current);
  if (found) return [{ ...found, note: found.available ? "hidden" : "noKey" }, ...list];
  const provider = current.split("/")[0];
  const keyed = models.providers.some((p) => p.id === provider && p.credential !== "missing");
  const gone: MenuModel = {
    id: current,
    name: modelName(current),
    provider,
    context_window: 0,
    reasoning: false,
    thinking_levels: [],
    default_thinking: "default",
    images: false,
    available: keyed,
    shown: true,
    known: false,
    note: keyed ? "gone" : "noKey",
  };
  return [gone, ...list];
}

/** "1M", "200K", "8K": a context window in tokens. */
export function tokensText(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** "$0.15 / $0.60": input and output prices per million tokens. */
export function priceText(cost: ModelPrice): string {
  const sign = cost.currency === "CNY" ? "¥" : "$";
  const n = (v: number) => sign + (v >= 10 ? v.toFixed(0) : v.toFixed(2));
  return `${n(cost.input)} / ${n(cost.output)}`;
}

/** What a failed task's error kind means, and what to do about it. */
export function failureTitle(kind: string): string {
  return i18n.exists(`common:failure.${kind}`) ? t(`failure.${kind}` as "failure.unknown") : t("failure.unknown");
}

export function failureAdvice(kind: string, retryable: boolean): string {
  if (i18n.exists(`common:advice.${kind}`)) return t(`advice.${kind}` as "advice.unknown");
  return retryable ? t("advice.retryable") : t("advice.unknown");
}
