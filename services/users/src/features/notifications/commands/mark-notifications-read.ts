import { trace } from "@opentelemetry/api";
import type { Db } from "#shared/db/prisma";
import type { CurrentUser } from "#shared/auth/current-user";
import { AuditActor } from "#shared/audit/audit-actor";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";

export interface MarkReadResult {
  updated: number;
  unread_count: number;
}

/**
 * Marks a list of the caller's notifications read.
 *
 * CONTRACT: One write endpoint covers all three cases — entering the All screen,
 * "Mark all as read", and marking a single one (a list of one). There is
 * deliberately no separate read-all route.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export class MarkNotificationsReadCommand {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async execute(currentUser: CurrentUser, ids: string[]): Promise<MarkReadResult> {
    return withWorkflowSpan(
      "notifications_marked_read",
      { app_event: "notifications_marked_read_started", requested_count: ids.length },
      () => this.doExecute(currentUser, ids),
    );
  }

  private async doExecute(currentUser: CurrentUser, ids: string[]): Promise<MarkReadResult> {
    const span = trace.getActiveSpan();
    const user = await currentUser.resolve();
    if (!user) {
      span?.setAttributes({
        app_event: "notifications_marked_read_failed",
        reason: "user_not_found",
      });
      return { updated: 0, unread_count: 0 };
    }

    // An empty list is the NORMAL case — arriving with nothing unread — so it
    // short-circuits rather than issuing an UPDATE matching nothing.
    if (ids.length === 0) {
      const unreadCount = await this.unreadCount(user.id);
      span?.setAttributes({
        app_event: "notifications_marked_read_succeeded",
        user_id: user.id,
        updated_count: 0,
      });
      return { updated: 0, unread_count: unreadCount };
    }

    // CONTRACT: `userId` IS the ownership check — another user's ids simply do not
    // match and are not counted, which is what keeps a single-id PATCH from
    // leaking the existence of someone else's notification. `readAt: null` makes
    // the write idempotent, and that matters because the web's mark-on-enter can
    // fire twice on an Angular remount.
    const { count } = await this.db.notification.updateMany({
      where: { id: { in: ids }, userId: user.id, readAt: null },
      data: { readAt: new Date(), updatedBy: AuditActor.NotificationsMarkedRead },
    });

    const unreadCount = await this.unreadCount(user.id);

    span?.setAttributes({
      app_event: "notifications_marked_read_succeeded",
      user_id: user.id,
      updated_count: count,
    });

    return { updated: count, unread_count: unreadCount };
  }

  private async unreadCount(userId: string): Promise<number> {
    return this.db.notification.count({ where: { userId, readAt: null } });
  }
}
