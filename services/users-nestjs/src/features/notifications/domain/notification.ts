import type { TrackingStatus } from "./notification-copy.ts";

/**
 * What `metadata` carries. Presentation is DERIVED from these facts rather than
 * baked into `title`/`body`: without `status` the web could print the string but
 * choose no icon and no tint, and without `order_id` there is no "View order" CTA.
 *
 * CONTRACT: Unknown fields are OMITTED, never null. A WELCOME row genuinely has no
 * order, and `order_id: null` would read as a resolved value that happens to be
 * null. See [[logging-context]]
 */
export interface NotificationMetadata {
  status?: TrackingStatus;
  order_id?: string;
  /** The DISPLAY form (`ORD-3MRAI-10482`), omitted when the order has none. */
  order_number?: string;
  /** When the event happened, as the producer stamped it. Not indexable. */
  occurred_at: string;
}

/** One notification as the service reasons about it. */
export interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  metadata: NotificationMetadata;
  readAt: Date | null;
  createdAt: Date;
}

/** The row shape this mapper accepts, narrowed to what it reads. */
interface NotificationRow {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  metadata: unknown;
  readAt: Date | null;
  createdAt: Date;
}

/** Maps a Prisma row to the domain type, narrowing `metadata` from Json. */
export function toDomain(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    title: row.title,
    body: row.body,
    metadata: (row.metadata ?? {}) as NotificationMetadata,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}
