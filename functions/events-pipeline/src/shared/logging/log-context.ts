import { AsyncLocalStorage } from "node:async_hooks";

// Per-RECORD log context, merged into EVERY log line by the `formatters.log`
// hook in `logger.ts`. The unit of context here is one SQS record, not one HTTP
// request: a single invocation processes a whole batch, and each record carries
// its own envelope. Scoping the store per record is what keeps one record's
// event_id from bleeding onto the next one's lines.
//
// Every field is OPTIONAL and omitted when unknown. An emitted `order_id: null`
// is worse than an absent key: it reads as a resolved value that happens to be
// null, rather than "not applicable to this line" — see
// docs/shared/conventions/logging-context.md.
//
// `trace_id`/`span_id` are deliberately NOT part of this store. They are read
// from the ACTIVE SPAN by `logger.ts`'s formatter, per line — a span id copied
// into this store when the record's span opened would then be stamped on lines
// emitted from deeper spans (the DocumentDB/SES/WS wrappers), pointing at the
// wrong span. The store is for values that hold for the whole record; the span
// ids are not among them.
export interface LogContextStore {
  /** Producer-generated event id — this event's only identifier. */
  event_id?: string;
  /** Event type driving the CQRS dispatch (e.g. USER_CREATED). */
  type?: string;
  /** Producing service (users, orders, tracking). */
  source?: string;
  /**
   * Internal `usr_` id carried by the envelope — the event's SUBJECT (who the
   * event is ABOUT), not who caused it. The originator is `author_*` below.
   */
  user_id?: string;
  /** Internal order id — absent on events that belong to no order. */
  order_id?: string;
  /**
   * The producer's semantic audit actor (`<source>:<action>`) — WHO ORIGINATED
   * this event. Flattened out of the envelope's `author` object rather than
   * nested, so a line stays one flat record the collector can index.
   */
  author_actor?: string;
  /**
   * The originating human's internal `usr_` id, when a human acted at all.
   *
   * NOT `user_id`: that key is already the event's subject, and the two are
   * routinely different values (an event about user A caused by a carrier
   * webhook, or by a different user). Reusing the key would let one silently
   * overwrite the other, producing a line that looks correct and attributes the
   * event to the wrong identity.
   */
  author_user_id?: string;
  /**
   * The originating human's Cognito sub. An identifier, not a secret, and a
   * standard field of the shared context — so it is loggable. No email ever
   * travels on `author`.
   */
  author_cognito_sub?: string;
  /**
   * The correlation id of the request that ultimately caused this event
   * (`req_` + nanoid), read off the envelope — never minted here.
   *
   * This is the field that makes a flow reconstructable across services from
   * the log stream alone. It stays useful alongside `trace_id`: `request_id`
   * is a plain propagated value that survives every hop, including any the OTel
   * SDK does not reach, and it is present on messages whose producer had no
   * active span.
   *
   * Absent on messages published before the producers started sending it —
   * omitted, never `request_id: null`.
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
 * No-op outside a record.
 *
 * Mutates in place rather than replacing the store, so continuations that
 * already captured the reference observe the update.
 */
export function setLogContext(fields: Partial<LogContextStore>): void {
  const store = logContext.getStore();
  if (store) Object.assign(store, fields);
}

/**
 * Run `fn` with `fields` as the log context for its whole async call chain.
 *
 * NOTE the `async () => await fn()` shape — NOT `logContext.run(fields, fn)`.
 * AsyncLocalStorage.run exits its store the moment the callback returns
 * synchronously, so passing `fn` directly lets a callback that merely BUILDS a
 * promise hand it back un-awaited, exit the store, and resolve later under
 * whatever store is active at the AWAIT site. That is a live hazard here: the
 * mongodb driver's operations and the SES client's `send()` both return
 * promises whose work continues long after the synchronous call returns, so
 * every line they produce would lose its record context. Awaiting INSIDE keeps
 * the store alive for the whole operation. This is the same class of bug as
 * Users' Prisma lazy-promise pitfall
 * (docs/lessons/2026-07-12-prisma-lazy-promise-als.md).
 */
export function runWithLogContext<T>(
  fields: LogContextStore,
  fn: () => Promise<T>,
): Promise<T> {
  return logContext.run(fields, async () => await fn());
}
