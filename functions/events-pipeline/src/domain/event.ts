// Prefixed nano-id prefix for this collection's friendlyId — see
// docs/shared/conventions/nano-id.md. `event_id` (below) is a DIFFERENT field:
// the producer-generated idempotency key, not the pipeline's own display id.
export const EVENT_ID_PREFIX = "evt_";

export type EventStatus = "STARTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export interface StatusHistoryEntry {
  status: EventStatus;
  timestamp: Date;
  error?: string;
}

// Mirrors docs/domains/events-pipeline/specs/events-pipeline-design.md's Data
// Model table, PLUS `event_id` — new in this milestone (idempotency key, unique
// index alongside friendlyId's own unique index; see the milestone design spec's
// "Idempotency (new field)" section).
export interface EventDocument {
  friendlyId: string;
  event_id: string;
  order_id: string | null;
  user_id: string;
  type: string;
  source: string;
  payload: Record<string, unknown>;
  status: EventStatus;
  error: string | null;
  status_history: StatusHistoryEntry[];
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
  deletedBy: string | null;
  deletedAt: Date | null;
  // Computed per docs/shared/conventions/audit-fields.md ("a computed flag,
  // true when deletedAt is set, false otherwise") and repeated in the
  // events-pipeline design spec. Users derives this via a Prisma client
  // extension; this repository is hand-written (Task 8), so there is no
  // extension to derive it implicitly on read. It is materialized here
  // instead: the repository stamps it alongside deletedAt/deletedBy on
  // every write (kept in sync, never computed ad hoc per call site), so
  // readers can query/filter on `isDeleted` directly.
  isDeleted: boolean;
}
