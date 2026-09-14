import type { Db } from "#shared/db/prisma";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { NanoIdConfig } from "#shared/id/nano-id";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";
import { publishToUser } from "#shared/realtime/websocket-publisher";
import {
  TRACKING_EVENT_STATUSES,
  placedCopy,
  trackingCopy,
  welcomeCopy,
  type NotificationCopy,
  type TrackingEventStatus,
} from "../domain/notification-copy.ts";
import type { NotificationMetadata } from "../domain/notification.ts";

/**
 * The three event types that produce a notification. Everything else is discarded.
 *
 * CONTRACT: ORDER_CREATED is the "order placed" trigger. PLACED is the status a
 * tracking row is CREATED in, never a transition, so no TRACKING_STATUS_CHANGED
 * ever carries it — a tracking-only mapping delivers no order-placed notification
 * at all. See [[2026-09-10-in-app-notifications-design]]
 */
const WELCOME_EVENT = "USER_CREATED";
const ORDER_PLACED_EVENT = "ORDER_CREATED";
const TRACKING_EVENT = "TRACKING_STATUS_CHANGED";

/**
 * The envelope fields this command reads. Deliberately narrower than the full wire
 * envelope: a wide type here would let a producer's unrelated field change ripple
 * into this consumer.
 */
export interface NotificationEnvelope {
  type: string;
  user_id: string;
  order_id: string | null;
  author: { actor: string; user_id?: string; cognito_sub?: string };
  payload: Record<string, unknown>;
}

/**
 * CONTRACT: Narrows to the FOUR transition statuses. `PLACED` fails this check on
 * purpose — it can only reach a row through ORDER_CREATED, so a tracking event
 * carrying it is a producer regression and must not be silently mapped.
 */
function isTrackingEventStatus(value: unknown): value is TrackingEventStatus {
  return (
    typeof value === "string" && TRACKING_EVENT_STATUSES.includes(value as TrackingEventStatus)
  );
}

/** The row a mapped event becomes, before ids and timestamps are stamped. */
interface MappedNotification {
  type: "WELCOME" | "ORDER_STATUS";
  copy: NotificationCopy;
  metadata: NotificationMetadata;
}

/**
 * Turns one event into a stored notification and pushes it to the owner's sockets.
 *
 * CONTRACT: NEVER throws on a permanent error — an unmappable event is logged and
 * reported as "discarded" so the consumer deletes the message. Throwing would
 * retry it to the DLQ with no chance of success, the same rationale as the
 * pipeline's PermanentError. See [[2026-09-10-in-app-notifications-design]]
 */
export class CreateNotificationCommand {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async execute(envelope: NotificationEnvelope): Promise<"created" | "discarded"> {
    return withWorkflowSpan(
      "notification_created",
      { app_event: "notification_created_started", event_type: envelope.type },
      () => this.doExecute(envelope),
    );
  }

  private async doExecute(envelope: NotificationEnvelope): Promise<"created" | "discarded"> {
    const mapped = this.map(envelope);
    if (mapped === null) return "discarded";

    // CONTRACT: BOTH `id` and `createdBy` are passed explicitly. `id` because
    // `Notification.id` has no database default — the extension stamps it only at
    // runtime, so the Prisma input type still demands it. `createdBy` because the
    // consumer runs outside any request, leaving the AsyncLocalStorage actor the
    // extension reads undefined against a non-nullable column.
    // See [[audit-fields]]
    const row = await this.db.notification.create({
      data: {
        id: NanoIdConfig.newNotificationId(),
        userId: envelope.user_id,
        type: mapped.type,
        title: mapped.copy.title,
        body: mapped.copy.body,
        metadata: mapped.metadata as never,
        createdBy: AuditActor.NotificationCreated,
      },
    });

    appLogger.info(
      {
        app_event: "notification_created_succeeded",
        event_type: envelope.type,
        notification_id: row.id,
        user_id: envelope.user_id,
        ...(mapped.metadata.order_id ? { order_id: mapped.metadata.order_id } : {}),
      },
      "notification created",
    );

    // CONTRACT: After the insert, and never allowed to fail it. publishToUser
    // swallows its own errors; this catch covers the count query and the sub
    // lookup, so a read failure cannot lose a row that is already committed.
    try {
      await this.push(envelope, row);
    } catch (err) {
      appLogger.error(
        {
          err,
          app_event: "notification_push_failed",
          reason: "push_preparation_failed",
          notification_id: row.id,
          user_id: envelope.user_id,
        },
        "notification stored but not pushed",
      );
    }

    return "created";
  }

  /** Maps an event to a row, or null when it produces no notification. */
  private map(envelope: NotificationEnvelope): MappedNotification | null {
    if (envelope.type === WELCOME_EVENT) {
      const createdAt = envelope.payload.createdAt;
      return {
        type: "WELCOME",
        copy: welcomeCopy(),
        metadata: {
          occurred_at: typeof createdAt === "string" ? createdAt : new Date().toISOString(),
        },
      };
    }

    if (envelope.type === ORDER_PLACED_EVENT) {
      return this.mapOrderPlaced(envelope);
    }

    if (envelope.type === TRACKING_EVENT) {
      return this.mapTrackingTransition(envelope);
    }

    // Defence in depth: the SNS filter policy should have kept this off the queue.
    appLogger.info(
      {
        app_event: "notification_discarded",
        reason: "not_a_notification_type",
        event_type: envelope.type,
      },
      "event type produces no notification",
    );
    return null;
  }

  /**
   * The PLACED variant. The payload is OrderCreatedPayloadSchema
   * (functions/events-pipeline/src/handlers/order-created.ts); only `created_at`
   * (the occurred_at source) and `order_number.formatted` (the body prefix) are
   * read here.
   */
  private mapOrderPlaced(envelope: NotificationEnvelope): MappedNotification | null {
    const createdAt = envelope.payload.created_at;
    if (typeof createdAt !== "string" || createdAt.length === 0) {
      // A permanent error: logged and consumed. `reason` names the field.
      appLogger.error(
        {
          app_event: "notification_created_failed",
          reason: "missing_created_at",
          event_type: envelope.type,
          user_id: envelope.user_id,
        },
        "ORDER_CREATED carried no created_at",
      );
      return null;
    }

    // CONTRACT: `order_number` is OPTIONAL on this payload, exactly as on the
    // tracking one — an order predating the backfill omits the key entirely, so
    // only the display form is read and its absence must degrade cleanly.
    const orderNumber = envelope.payload.order_number as { formatted?: string } | undefined;
    const formatted = orderNumber?.formatted;
    const orderId =
      envelope.order_id ??
      (typeof envelope.payload.order_id === "string" ? envelope.payload.order_id : undefined);

    return {
      type: "ORDER_STATUS",
      copy: placedCopy({ orderNumberFormatted: formatted }),
      metadata: {
        // Stored identically to the four tracking-driven rows — only the
        // triggering event differs, and nothing downstream needs to know which.
        status: "PLACED",
        ...(orderId ? { order_id: orderId } : {}),
        ...(formatted ? { order_number: formatted } : {}),
        occurred_at: createdAt,
      },
    };
  }

  /** One of the four transition variants, or null when the status is unmappable. */
  private mapTrackingTransition(envelope: NotificationEnvelope): MappedNotification | null {
    const status = envelope.payload.status;
    if (!isTrackingEventStatus(status)) {
      // A permanent error: logged and consumed. `reason` names the field. PLACED
      // lands here too, and correctly so: it is never a transition.
      appLogger.error(
        {
          app_event: "notification_created_failed",
          reason: "unknown_tracking_status",
          event_type: envelope.type,
          user_id: envelope.user_id,
        },
        "TRACKING_STATUS_CHANGED carried an unmappable status",
      );
      return null;
    }

    const changedAt = envelope.payload.changed_at;
    const occurredAt = typeof changedAt === "string" ? changedAt : new Date().toISOString();
    // `order_number` is an object on the wire and OMITTED when the order has
    // none; only its display form is stored.
    const orderNumber = envelope.payload.order_number as { formatted?: string } | undefined;
    const formatted = orderNumber?.formatted;
    const orderId = envelope.order_id ?? undefined;

    return {
      type: "ORDER_STATUS",
      copy: trackingCopy({ status, orderNumberFormatted: formatted, changedAt: occurredAt }),
      metadata: {
        status,
        ...(orderId ? { order_id: orderId } : {}),
        ...(formatted ? { order_number: formatted } : {}),
        occurred_at: occurredAt,
      },
    };
  }

  /** Resolves the owner's Cognito sub and pushes the frame. */
  private async push(
    envelope: NotificationEnvelope,
    row: {
      id: string;
      type: string;
      title: string;
      body: string;
      metadata: unknown;
      readAt: Date | null;
    },
  ): Promise<void> {
    // CONTRACT: The socket registry is keyed by `cognito_sub`, never the internal
    // `usr_` id. Prefer the envelope's, which the producer read off the persisted
    // row; a carrier-webhook transition omits it, so fall back to a local SELECT
    // on this service's own users table — no remote call.
    // See [[user-id-vs-cognito-sub-ownership-key]]
    let cognitoSub = envelope.author.cognito_sub;
    if (!cognitoSub) {
      const user = await this.db.user.findFirst({
        where: { id: envelope.user_id },
        select: { cognitoSub: true },
      });
      cognitoSub = user?.cognitoSub ?? undefined;
    }

    // Not an error: a user with no Cognito identity has no socket to push to, and
    // the row is served the next time the panel is opened.
    if (!cognitoSub) return;

    const unreadCount = await this.db.notification.count({
      where: { userId: envelope.user_id, readAt: null },
    });

    await publishToUser(cognitoSub, {
      type: "NOTIFICATION_CREATED",
      notification: {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        metadata: row.metadata,
        read_at: row.readAt ? row.readAt.toISOString() : null,
      },
      unread_count: unreadCount,
    });
  }
}
