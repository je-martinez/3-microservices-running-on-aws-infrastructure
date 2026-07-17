import type { Db } from "#shared/db/prisma";

// Request-scoped caller context. `identity` is the raw x-user-id (Cognito sub or
// usr_ id). `resolve()` turns it into a user row lazily, caching the promise so
// repeat consumers in one request don't re-hit the DB. Registered SCOPED in
// Awilix (routes.ts onRequest hook).
export class CurrentUser {
  readonly identity: string;
  private readonly db: Db;
  private cached?: ReturnType<Db["user"]["findByIdOrCognitoSub"]>;

  constructor(deps: { db: Db; identity: string }) {
    this.db = deps.db;
    this.identity = deps.identity;
  }

  resolve() {
    // Cache the PROMISE (not just the value) so concurrent callers share one lookup.
    this.cached ??= this.db.user.findByIdOrCognitoSub(this.identity);
    return this.cached;
  }
}
