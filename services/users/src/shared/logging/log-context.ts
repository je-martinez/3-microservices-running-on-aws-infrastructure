import { AsyncLocalStorage } from "node:async_hooks";

// Per-request log context, merged into EVERY log line by the `formatters.log`
// hook in `logger.ts`. A sibling to `shared/audit/actor-context.ts`, which uses
// the same mechanism for the audit actor — see that file for why
// AsyncLocalStorage rather than the per-request Awilix scope (the Pino logger,
// like the Prisma client, is a process-wide singleton and cannot read a scope).
//
// Every field is OPTIONAL and omitted when unknown. An emitted `user_id: null`
// is worse than an absent key: it reads as a resolved value that happens to be
// null, rather than "not known at this point in the request".
export interface LogContextStore {
  /** Raw Cognito sub, from the x-user-id header. */
  cognito_sub?: string;
  /** Internal `usr_` id, once identity has been resolved. */
  user_id?: string;
  /** Non-reversible email id — safe to carry on every line. */
  email_hash?: string;
  /**
   * Plaintext email. ONLY set on the login/register flows, where no user_id
   * exists yet and the email is the sole diagnostic key. Never set elsewhere.
   */
  email?: string;
  order_id?: string;
}

export const logContext = new AsyncLocalStorage<LogContextStore>();

/** The active context, or an empty object outside a request. */
export function getLogContext(): LogContextStore {
  return logContext.getStore() ?? {};
}

/**
 * Merge fields into the ACTIVE store, for enrichment part-way through a request
 * — e.g. once registration produces a user_id, every later line of that request
 * carries it. No-op outside a request.
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
 * Prisma's create/update/deleteMany return a LAZY PrismaPromise that starts no
 * work until awaited, and AsyncLocalStorage.run exits its store the moment the
 * callback returns synchronously. Passing `fn` directly therefore lets a
 * callback like `() => db.user.create(...)` hand back an un-started thenable,
 * exit the store, and run the query later under whatever store is active at the
 * AWAIT site. Awaiting inside keeps the store alive for the whole operation.
 * The same hazard is documented at length in shared/audit/actor-context.ts,
 * where it silently mis-stamped audit columns.
 */
export function runWithLogContext<T>(
  fields: LogContextStore,
  fn: () => Promise<T>,
): Promise<T> {
  return logContext.run(fields, async () => await fn());
}
