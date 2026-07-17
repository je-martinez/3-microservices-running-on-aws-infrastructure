import type { Db } from "#shared/db/prisma";
import type { CurrentUser } from "#shared/auth/current-user";
import { toDomain, type User } from "../domain/user.ts";

// Constructor-injected from the Awilix cradle (PROXY injection mode).
// Groups the read-only user lookups (getMe, getUserById) since both share the
// same reader-backed, soft-delete-aware query shape.
export class UserQueryService {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async getMe(currentUser: CurrentUser): Promise<User | null> {
    // Soft-deleted rows are excluded automatically by the query extension
    // (see [[soft-delete]] and `shared/db/prisma-extensions.ts`); reads are
    // routed to the read replica by `@prisma/extension-read-replicas`. The
    // id-or-cognitoSub resolution is delegated to the request-scoped
    // `CurrentUser` context, which caches the lookup once per request (see
    // `shared/auth/current-user.ts`) instead of re-resolving it here.
    const row = await currentUser.resolve();
    return row ? toDomain(row as any) : null;
  }

  async getUserById(id: string): Promise<User | null> {
    const row = await this.db.user.findByIdOrCognitoSub(id);
    return row ? toDomain(row as any) : null;
  }
}
