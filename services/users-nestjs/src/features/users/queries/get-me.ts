import type { Db } from "#shared/db/prisma";
import type { CurrentUser } from "#shared/auth/current-user";
import { toDomain, type User } from "../domain/user.ts";
import { trace } from "@opentelemetry/api";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";

// Constructor-injected from the Awilix cradle (PROXY injection mode).
// Groups the read-only user lookups (getMe, getUserById) since both share the
// same reader-backed, soft-delete-aware query shape.
export class UserQueryService {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  // The span carries no attribute derived from `currentUser.identity`: that
  // header is either a `usr_` id or a Cognito sub, so labelling it as one of
  // them would be a guess. The resolved `user_id` is set below once it is
  // actually known — and it is never null, per [[logging-context]].
  async getMe(currentUser: CurrentUser): Promise<User | null> {
    return withWorkflowSpan("get_profile", { app_event: "get_profile_started" }, () =>
      this.doGetMe(currentUser),
    );
  }

  private async doGetMe(currentUser: CurrentUser): Promise<User | null> {
    // Soft-deleted rows are excluded automatically by the query extension
    // (see [[soft-delete]] and `shared/db/prisma-extensions.ts`); reads are
    // routed to the read replica by `@prisma/extension-read-replicas`. The
    // id-or-cognitoSub resolution is delegated to the request-scoped
    // `CurrentUser` context, which caches the lookup once per request (see
    // `shared/auth/current-user.ts`) instead of re-resolving it here.
    const row = await currentUser.resolve();

    // A missing user is a routine outcome here (the route turns it into a 404),
    // NOT a thrown error — so it never reaches withWorkflowSpan's catch and the
    // span status stays OK. The distinction is recorded in `app_event`/`reason`
    // instead, which is what an operator filters on.
    const span = trace.getActiveSpan();
    if (row) {
      span?.setAttributes({ app_event: "get_profile_succeeded", user_id: row.id });
    } else {
      span?.setAttributes({ app_event: "get_profile_failed", reason: "user_not_found" });
    }

    return row ? toDomain(row as any) : null;
  }

  async getUserById(id: string): Promise<User | null> {
    const row = await this.db.user.findByIdOrCognitoSub(id);
    return row ? toDomain(row as any) : null;
  }
}
