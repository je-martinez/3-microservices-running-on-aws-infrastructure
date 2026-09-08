import { AsyncLocalStorage } from "node:async_hooks";

// CONTRACT: Every field is optional and OMITTED when unknown, never null — a
// `user_id: null` reads as a resolved value rather than "not known yet". Merged
// into every line by `formatters.log` in logger.ts. AsyncLocalStorage rather than
// the Awilix scope because the Pino logger is a process-wide singleton.
// See [[logging-context]]
export interface LogContextStore {
  /**
   * Correlation id for one logical request, `req_` + nanoid, seeded at ingress and
   * forwarded on every outbound hop. Distinct from `trace_id`: the events-pipeline
   * and realtime Lambdas run no OTel SDK, so this is the only id spanning them.
   * See [[2026-08-15-request-id-correlation-design]]
   */
  request_id?: string;
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
  /**
   * Cache outcome: "hit" | "miss" | "bypass", set by the response-cache hooks on
   * cacheable routes. OMITTED elsewhere, never null — an absent key reads as "not
   * cached", a null as "cached and somehow produced no outcome".
   */
  cache_result?: "hit" | "miss" | "bypass";
  /**
   * E2E ONLY. The Playwright run behind this request, seeded at ingress from
   * `x-e2e-run-id` and only when `E2E_TESTING_ENABLED`, so an unflagged environment
   * ignores the header. On the context rather than a parameter so it reaches every
   * event published — see [[2026-08-29-e2e-email-support-store]].
   */
  run_id?: string;
}

export const logContext = new AsyncLocalStorage<LogContextStore>();

/** The active context, or an empty object outside a request. */
export function getLogContext(): LogContextStore {
  return logContext.getStore() ?? {};
}

/**
 * Merge fields into the ACTIVE store, for enrichment part-way through a request.
 * No-op outside one. Mutates in place so continuations that already captured the
 * reference observe the update.
 */
export function setLogContext(fields: Partial<LogContextStore>): void {
  const store = logContext.getStore();
  if (store) Object.assign(store, fields);
}

/**
 * Run `fn` with `fields` as the log context for its whole async call chain.
 *
 * CONTRACT: Keep the `async () => await fn()` shape — do NOT pass `fn` directly to
 * `logContext.run`. Prisma promises are lazy, so a callback returning an un-started
 * thenable exits the store before the query runs and it executes under whatever
 * store is active at the AWAIT site. See [[2026-07-12-prisma-lazy-promise-als]]
 */
export function runWithLogContext<T>(
  fields: LogContextStore,
  fn: () => Promise<T>,
): Promise<T> {
  return logContext.run(fields, async () => await fn());
}
