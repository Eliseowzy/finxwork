import { hourMinute, isYesterday, modelName, monthDay, sameDay, weekday, withinWeek, type Bucket, type ToolView, type WorkItem, workSummary } from "@finx/client";
import type { ModelsListResult, PermissionMode, SessionState, ThinkingLevel } from "@finx/protocol";
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

/** A message's time under it: "12 秒前", "5 分钟前", "3 小时前", "2 天前" within a week, else the date and time. */
export function messageAgo(d: Date, now: Date): string {
  const s = Math.max(0, (now.getTime() - d.getTime()) / 1000);
  if (s < 60) return t("time.secondsAgo", { count: Math.max(1, Math.trunc(s)) });
  if (s < 3600) return t("time.minutesAgo", { count: Math.trunc(s / 60) });
  if (s < 86400) return t("time.hoursAgo", { count: Math.trunc(s / 3600) });
  if (s < 7 * 86400) return t("time.daysAgo", { count: Math.trunc(s / 86400) });
  return `${monthDay(d, language())} ${hourMinute(d)}`;
}

/** How often a message's time needs redrawing: every second in its first minute, then every minute, then every ten. */
export function agoInterval(d: Date): number {
  const s = (Date.now() - d.getTime()) / 1000;
  return s < 60 ? 1000 : s < 3600 ? 60_000 : 600_000;
}

/** The session list's time: how long ago today, then "Yesterday", a weekday, or the date. */
export function listTime(d: Date, now: Date): string {
  return sameDay(d, now) ? agoText(d, now) : shortTime(d, now);
}

/** A time line before a message, only for the first one and after a pause of half an hour: "Today 18:22". */
export function timeLine(at: Date, previous: Date | undefined, now: Date): string | null {
  if (previous && at.getTime() - previous.getTime() < 30 * 60_000) return null;
  const day = sameDay(at, now) ? t("time.today") : isYesterday(at, now) ? t("time.yesterday") : withinWeek(at, now) ? weekday(at, language()) : monthDay(at, language());
  return `${day} ${hourMinute(at)}`;
}

/** "2 min 14 s", "48 s". */
export function durationText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? t("time.seconds", { count: s }) : t("time.minutesSeconds", { m: Math.trunc(s / 60), s: s % 60 });
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

/** A model's name as its provider lists it, else its short reference. */
export function modelTitle(ref: string, models: ModelsListResult): string {
  const found = models.models.find((m) => m.id === ref);
  if (found) return found.name;
  return modelName(ref);
}

/** What a failed task's error kind means, and what to do about it. */
export function failureTitle(kind: string): string {
  return i18n.exists(`common:failure.${kind}`) ? t(`failure.${kind}` as "failure.unknown") : t("failure.unknown");
}

export function failureAdvice(kind: string, retryable: boolean): string {
  if (i18n.exists(`common:advice.${kind}`)) return t(`advice.${kind}` as "advice.unknown");
  return retryable ? t("advice.retryable") : t("advice.unknown");
}
