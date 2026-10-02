import { AsyncLocalStorage } from "node:async_hooks";

// CONTRACT: Every field is optional and OMITTED when unknown, never null — a
// `user_id: null` reads as a resolved value rather than "not known yet". Merged
// into every line by `formatters.log` in logger.ts. AsyncLocalStorage rather than
// a request-scoped provider because the Pino logger is a process-wide singleton.
// See [[logging-context]]
export interface LogContextStore {
  /**
   * `req_` + nanoid, seeded at ingress and forwarded on every outbound hop — the only
   * id spanning the events-pipeline and realtime Lambdas, which run no OTel SDK.
   * See [[2026-08-15-request-id-correlation-design]]
   */
  request_id?: string;
  /** Raw sub, from the x-user-id header — NOT the `usr_` id. */
  cognito_sub?: string;
  user_id?: string;
  /**
   * WARNING: The only email identifier this store carries — it reaches every later
   * line. A masked email goes on the log call site. See [[logging-context]]
   */
  email_hash?: string;
  order_id?: string;
  /** Set by MeCacheInterceptor on `GET /v1/users/me` only. */
  cache_result?: "hit" | "miss" | "bypass";
  /**
   * E2E ONLY: the Playwright run, seeded from `x-e2e-run-id` only when `E2E_TESTING_ENABLED`.
   * Ambient so it reaches every published event. See [[2026-08-29-e2e-email-support-store]]
   */
  run_id?: string;
}

export const logContext = new AsyncLocalStorage<LogContextStore>();

export function getLogContext(): LogContextStore {
  return logContext.getStore() ?? {};
}

/** No-op outside a request. Mutates in place so continuations holding the store see the update. */
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
