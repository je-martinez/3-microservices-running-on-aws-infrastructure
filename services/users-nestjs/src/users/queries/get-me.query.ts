import { type IQueryHandler, QueryHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { CurrentUser } from "#shared/auth/current-user";
import { toDomain, type User } from "#features/users/domain/user";
import { RoutineFailure, Workflow } from "#shared/observability/workflow-metadata";

export class GetMeQuery {
  constructor(public readonly currentUser: CurrentUser) {}
}

@Workflow("get_profile")
@QueryHandler(GetMeQuery)
export class GetMeHandler implements IQueryHandler<GetMeQuery> {
  // Soft-deleted rows are excluded by the query extension and reads are routed
  // to the replica; the id-or-cognitoSub resolution is delegated to the
  // request-scoped CurrentUser, which caches it once per request.
  // See [[soft-delete]]
  async execute(query: GetMeQuery): Promise<User | RoutineFailure> {
    const row = await query.currentUser.resolve();

    if (!row) {
      // CONTRACT: A missing user is a routine outcome — the controller turns it
      // into a 404, so the span keeps OK status and the reason carries the
      // meaning. See [[logging-context]]
      return new RoutineFailure("user_not_found");
    }

    trace.getActiveSpan()?.setAttributes({ user_id: row.id });
    return toDomain(row as never);
  }
}
