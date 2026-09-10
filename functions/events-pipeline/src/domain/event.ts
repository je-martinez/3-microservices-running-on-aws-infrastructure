export type EventStatus = "STARTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export interface StatusHistoryEntry {
  status: EventStatus;
  timestamp: Date;
  error?: string;
}

// CONTRACT: `event_id` is the producer-generated idempotency key and THE
// identifier of an event; the pipeline mints no display id of its own. Every
// persisted field is snake_case, and it must stay that way — this repository is
// hand-written with no ORM mapping layer, so the TypeScript property name IS the
// stored field name.
// See [[events-pipeline-design]]
export interface EventDocument {
  event_id: string;
  order_id: string | null;
  user_id: string;
  type: string;
  source: string;
  payload: Record<string, unknown>;
  status: EventStatus;
  error: string | null;
  status_history: StatusHistoryEntry[];
  created_by: string;
  created_at: Date;
  updated_by: string;
  updated_at: Date;
  deleted_by: string | null;
  deleted_at: Date | null;
  // CONTRACT: Materialized on write, alongside deleted_at/deleted_by — never
  // computed per call site. This repository is hand-written, so nothing derives
  // it on read the way Users' Prisma extension does.
  // See [[audit-fields]]
  is_deleted: boolean;
}
