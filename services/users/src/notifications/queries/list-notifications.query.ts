import { Inject } from "@nestjs/common";
import { type IQueryHandler, QueryHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { Db } from "#shared/db/prisma";
import type { CurrentUser } from "#shared/auth/current-user";
import { DB } from "#shared/tokens";
import { RoutineFailure, Workflow } from "#shared/observability/workflow-metadata";
import {
  NOTIFICATIONS_LIMIT,
  toDomain,
  WINDOW_DAYS,
  type Notification,
} from "#features/notifications/domain/notification";

// Re-exported so existing importers reach the domain's single definition.
export { NOTIFICATIONS_LIMIT, WINDOW_DAYS };



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

export class ListNotificationsQuery {
  constructor(
    public readonly currentUser: CurrentUser,
    public readonly filter: NotificationFilter,
  ) {}
}

@Workflow("list_notifications")
@QueryHandler(ListNotificationsQuery)
export class ListNotificationsHandler implements IQueryHandler<ListNotificationsQuery> {
  constructor(@Inject(DB) private readonly db: Db) {}

  async execute({
    currentUser,
    filter,
  }: ListNotificationsQuery): Promise<NotificationsPage | RoutineFailure<NotificationsPage>> {
    const span = trace.getActiveSpan();
    span?.setAttributes({
      app_event: "list_notifications_started",
      notification_filter: filter,
    });

    // Resolves the raw x-user-id (a Cognito sub or a usr_ id) to the internal id
    // and enriches the log context with `user_id` as a side effect.
    const user = await currentUser.resolve();
    if (!user) {
      // CONTRACT: A missing user is a routine outcome — the controller serves the
      // empty page, so the span keeps OK status and the reason carries the
      // meaning. Only a THROW sets ERROR. See [[logging-context]]
      span?.setAttributes({ app_event: "list_notifications_failed", reason: "user_not_found" });
      return new RoutineFailure("user_not_found", EMPTY_PAGE);
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
}
