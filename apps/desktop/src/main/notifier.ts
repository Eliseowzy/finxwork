import { badgeCount, botAlerts, deletedBotGroup, deletedSessionGroup, sessionAlerts, type Alert, type AlertChange, type AlertSession } from "@finx/client";
import type { BotSummary } from "@finx/protocol";
import type { NotificationSettings } from "../shared/bridge";

// Follows the service's lists from the main process, so it works with every window closed, and
// decides what reaches the system (docs/desktop/notification-design.md §5). What counts as news is
// in @finx/client (alerts.ts); here is whether to say it now. A notification is only a reminder:
// what it would have said is still in the unread count and the conversation.

/** What the notifier does to the system. */
export type NotifierHost = {
  show(alert: Alert, sound: boolean): void;
  clear(ids: string[]): void;
  clearGroups(groups: string[]): void;
  setBadge(count: number): void;
  /** The person is looking at the app. */
  inFront(): boolean;
  settings(): NotificationSettings;
};

export class Notifier {
  private readonly bots = new Map<string, BotSummary>();
  private readonly sessions = new Map<string, AlertSession>();
  private botsListed = false;
  private sessionsListed = false;
  private badge = 0;

  private readonly host: NotifierHost;

  constructor(host: NotifierHost) {
    this.host = host;
  }

  /**
   * A new connection to the service. The next lists say how things are; what happened meanwhile
   * is no news, as the unread counts say it. The rows stay until then, for the icon's number.
   */
  reconnected() {
    this.botsListed = this.sessionsListed = false;
  }

  botList(list: BotSummary[]) {
    this.bots.clear();
    for (const b of list) this.bots.set(b.id, b);
    this.botsListed = true;
    this.refresh();
  }

  sessionList(list: AlertSession[]) {
    this.sessions.clear();
    for (const s of list) this.sessions.set(s.session_id, s);
    this.sessionsListed = true;
    this.refresh();
  }

  botsChanged(changed: BotSummary[], deleted: string[] = []) {
    if (!this.botsListed) return;
    for (const b of changed) {
      this.apply(botAlerts(this.bots.get(b.id), b));
      this.bots.set(b.id, b);
    }
    for (const id of deleted) {
      this.bots.delete(id);
      this.host.clearGroups([deletedBotGroup(id)]);
    }
    this.refresh();
  }

  sessionsChanged(changed: AlertSession[], deleted: string[] = []) {
    if (!this.sessionsListed) return;
    for (const s of changed) {
      this.apply(sessionAlerts(this.sessions.get(s.session_id), s));
      this.sessions.set(s.session_id, s);
    }
    for (const id of deleted) {
      this.sessions.delete(id);
      this.host.clearGroups([deletedSessionGroup(id)]);
    }
    this.refresh();
  }

  /** The icon's number now: after a change, or the settings changing. */
  refresh() {
    const count = this.host.settings().enabled ? badgeCount(this.bots.values(), this.sessions.values()) : 0;
    if (count === this.badge) return;
    this.badge = count;
    this.host.setBadge(count);
  }

  private apply(change: AlertChange) {
    if (change.clear.length) this.host.clear(change.clear);
    if (change.clearGroups.length) this.host.clearGroups(change.clearGroups);
    if (!change.alerts.length) return;
    const settings = this.host.settings();
    if (!settings.enabled || this.host.inFront()) return;
    for (const alert of change.alerts) {
      if (alert.kind === "session_ended" && !settings.sessionEnded) continue;
      this.host.show(alert, settings.sound);
    }
  }
}
