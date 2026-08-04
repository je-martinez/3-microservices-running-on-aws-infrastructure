export type EventStatus = "STARTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export interface StatusHistoryEntry {
  status: EventStatus;
  timestamp: Date;
  error?: string;
}

// Mirrors docs/domains/events-pipeline/specs/events-pipeline-design.md's Data
// Model table, PLUS `event_id` — new in this milestone: the producer-generated
// idempotency key, carrying its own unique index (see the milestone design
// spec's "Idempotency (new field)" section). It is THE identifier of an event;
// the pipeline mints no second display id of its own.
//
// Every persisted field is snake_case. The other services reach the same shape
// through an ORM mapping (Prisma's @map("created_by"), SQLAlchemy's
// Mapped[str], EF Core's HasColumnName) — this repository is hand-written, with
// no mapping layer, so the TypeScript property name IS the stored field name
// and must therefore be snake_case itself.
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
  // Computed per docs/shared/conventions/audit-fields.md ("a computed flag,
  // true when deleted_at is set, false otherwise") and repeated in the
  // events-pipeline design spec. Users derives this via a Prisma client
  // extension; this repository is hand-written (Task 8), so there is no
  // extension to derive it implicitly on read. It is materialized here
  // instead: the repository stamps it alongside deleted_at/deleted_by on
  // every write (kept in sync, never computed ad hoc per call site), so
  // readers can query/filter on `is_deleted` directly.
  is_deleted: boolean;
}
