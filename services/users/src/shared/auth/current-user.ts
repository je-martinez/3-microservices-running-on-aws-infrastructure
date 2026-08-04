import type { Db } from "#shared/db/prisma";
import { setLogContext } from "#shared/logging/log-context";

// Request-scoped caller context. `identity` is the raw x-user-id (Cognito sub or
// usr_ id). `resolve()` turns it into a user row lazily, caching the promise so
// repeat consumers in one request don't re-hit the DB. Registered SCOPED in
// Awilix (routes.ts onRequest hook).
export class CurrentUser {
  readonly identity: string;
  private readonly db: Db;
  private cached?: Promise<Awaited<ReturnType<Db["user"]["findByIdOrCognitoSub"]>>>;

  constructor(deps: { db: Db; identity: string }) {
    this.db = deps.db;
    this.identity = deps.identity;
  }

  resolve() {
    // Cache the PROMISE (not just the value) so concurrent callers share one lookup.
    this.cached ??= this.lookup();
    return this.cached;
  }

  // Resolving identity is where a request first learns its internal `usr_` id,
  // so it is also where the log context gets enriched: every later line of the
  // request then carries `user_id` without any call site passing it. This is
  // the single choke point for it — the onRequest hook only knows the raw
  // x-user-id (which may be a Cognito sub), and both authenticated routes
  // (GET/PATCH /v1/users/me) reach their user through here. Enriching here
  // rather than in an onRequest hook also keeps it free for routes that never
  // need the user: `resolve()` is lazy, so no request pays a lookup it wasn't
  // already making.
  private async lookup() {
    // The await MUST happen inside this async method, not at the call site:
    // `findByIdOrCognitoSub` returns a LAZY PrismaPromise, and the log context
    // is an AsyncLocalStorage store. Awaiting here keeps the enrichment on the
    // request's own store (see [[prisma-lazy-promise-als]] and the note in
    // shared/logging/log-context.ts).
    const row = await this.db.user.findByIdOrCognitoSub(this.identity);
    // Best-effort: a valid token whose user no longer exists (deleted account)
    // resolves to null, and the request carries on without user_id. Never emit
    // `user_id: null` — an absent key means "not known", whereas null reads as
    // a resolved value that happens to be null.
    if (row?.id) {
      setLogContext({ user_id: row.id });
    }
    return row;
  }
}
