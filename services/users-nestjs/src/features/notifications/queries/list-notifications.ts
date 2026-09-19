import { trace } from "@opentelemetry/api";
import type { Db } from "#shared/db/prisma";
import type { CurrentUser } from "#shared/auth/current-user";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";
import { toDomain, type Notification } from "../domain/notification.ts";

/**
 * CONTRACT: A hard cap with NO pagination, by decision. `window_total` is computed
 * separately so the count pill stays exact when the cap truncates the list.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export const NOTIFICATIONS_LIMIT = 50;

/**
 * CONTRACT: 90 days bounds `window_total` ONLY. The list query has NO date bound —
 * a date-filtered list would hide an old WELCOME row the All screen shows in its
 * EARLIER group.
 */
export const WINDOW_DAYS = 90 as const;

export type NotificationFilter = "all" | "unread" | "read";

export interface NotificationsPage {
  items: Notification[];
  unread_count: number;
  window_total: number;
  // The literal type, not `number`: the response schema declares z.literal(90) and
  // a widened `number` fails to assign at the route's serializer boundary.
  window_days: typeof WINDOW_DAYS;
}

const EMPTY_PAGE: NotificationsPage = {
  items: [],
  unread_count: 0,
  window_total: 0,
  window_days: WINDOW_DAYS,
};

/** Translates a filter into the `readAt` clause, or nothing for "all". */
function readAtClause(filter: NotificationFilter): { readAt?: null | { not: null } } {
  if (filter === "unread") return { readAt: null };
  if (filter === "read") return { readAt: { not: null } };
  return {};
}

export class NotificationQueryService {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async list(currentUser: CurrentUser, filter: NotificationFilter): Promise<NotificationsPage> {
    return withWorkflowSpan(
      "list_notifications",
      { app_event: "list_notifications_started", notification_filter: filter },
      () => this.doList(currentUser, filter),
    );
  }

  private async doList(
    currentUser: CurrentUser,
    filter: NotificationFilter,
  ): Promise<NotificationsPage> {
    const span = trace.getActiveSpan();
    // Resolves the raw x-user-id (a Cognito sub or a usr_ id) to the internal id
    // and enriches the log context with `user_id` as a side effect.
    const user = await currentUser.resolve();
    if (!user) {
      // A routine outcome (a valid token whose user was deleted), not an error, so
      // the span status stays OK and the distinction rides on app_event.
      span?.setAttributes({ app_event: "list_notifications_failed", reason: "user_not_found" });
      return EMPTY_PAGE;
    }

    const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // Soft-deleted rows are excluded by the query extension, and reads are routed
    // to the replica. Both counts ignore `filter`: the pill on the Unread tab must
    // read the same totals as on All. See [[soft-delete]]
    const [rows, unreadCount, windowTotal] = await Promise.all([
      this.db.notification.findMany({
        where: { userId: user.id, ...readAtClause(filter) },
        orderBy: { createdAt: "desc" },
        take: NOTIFICATIONS_LIMIT,
      }),
      this.db.notification.count({ where: { userId: user.id, readAt: null } }),
      this.db.notification.count({
        where: { userId: user.id, createdAt: { gte: windowStart } },
      }),
    ]);

    span?.setAttributes({
      app_event: "list_notifications_succeeded",
      user_id: user.id,
      notification_count: rows.length,
    });

    return {
      items: rows.map(toDomain),
      unread_count: unreadCount,
      window_total: windowTotal,
      window_days: WINDOW_DAYS,
    };
  }

  /** The badge count on its own, for the dedicated endpoint. */
  async unreadCount(currentUser: CurrentUser): Promise<number> {
    const user = await currentUser.resolve();
    if (!user) return 0;
    return this.db.notification.count({ where: { userId: user.id, readAt: null } });
  }
}
