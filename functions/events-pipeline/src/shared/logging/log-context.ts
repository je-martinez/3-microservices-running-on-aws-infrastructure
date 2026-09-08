import { AsyncLocalStorage } from "node:async_hooks";

// CONTRACT: The context unit is one SQS RECORD, not one invocation — a batch
// shares an invocation, and a wider scope bleeds one record's event_id onto the
// next one's lines. Every field is optional and OMITTED when unknown, never
// null. Do NOT put `trace_id`/`span_id` here: they are read per line from the
// active span, and a copy taken when the record opened would mislabel every
// line emitted from a deeper span.
// See [[logging-context]]
export interface LogContextStore {
  /** Producer-generated event id — this event's only identifier. */
  event_id?: string;
  /** Event type driving the CQRS dispatch (e.g. USER_CREATED). */
  type?: string;
  /** Producing service (users, orders, tracking). */
  source?: string;
  /** Envelope's `usr_` id — the event's SUBJECT, not its cause (see `author_*`). */
  user_id?: string;
  /** Internal order id — absent on events that belong to no order. */
  order_id?: string;
  /**
   * The producer's audit actor (`<source>:<action>`) — WHO ORIGINATED the event.
   * Flattened out of `author` so a line stays one flat, indexable record.
   */
  author_actor?: string;
  /**
   * The originating human's internal `usr_` id, when a human acted at all.
   * CONTRACT: Do NOT log this as `user_id` — that key is the event's SUBJECT and
   * the two routinely differ, so one silently overwrites the other and the line
   * attributes the event to the wrong identity.
   */
  author_user_id?: string;
  /** The originating human's Cognito sub — an identifier, not a secret. */
  author_cognito_sub?: string;
  /**
   * Correlation id of the causing request (`req_` + nanoid), read off the
   * envelope, never minted here. Omitted when absent, never null.
   */
  request_id?: string;
  /** SQS message id, the key that ties a line to a batchItemFailures entry. */
  message_id?: string;
}

export const logContext = new AsyncLocalStorage<LogContextStore>();

/** The active context, or an empty object outside a record. */
export function getLogContext(): LogContextStore {
  return logContext.getStore() ?? {};
}

/**
 * Merge fields into the ACTIVE store, for enrichment part-way through a record.
 * No-op outside a record. Mutates in place rather than replacing the store, so
 * continuations that already captured the reference observe the update.
 */
export function setLogContext(fields: Partial<LogContextStore>): void {
  const store = logContext.getStore();
  if (store) Object.assign(store, fields);
}

/**
 * Run `fn` with `fields` as the log context for its whole async call chain.
 *
 * CONTRACT: Keep the `async () => await fn()` shape — do NOT pass `fn` straight
 * to `logContext.run`. The store exits when the callback returns synchronously,
 * so an un-awaited promise resolves under whatever store is active at the AWAIT
 * site and every line it emits loses its record context. Live hazard here: the
 * mongodb driver's and SES client's promises both outlive the sync call.
 * See [[2026-07-12-prisma-lazy-promise-als]]
 */
export function runWithLogContext<T>(
  fields: LogContextStore,
  fn: () => Promise<T>,
): Promise<T> {
  return logContext.run(fields, async () => await fn());
}
