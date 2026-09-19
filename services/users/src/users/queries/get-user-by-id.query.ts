import { Inject } from "@nestjs/common";
import { type IQueryHandler, QueryHandler } from "@nestjs/cqrs";
import type { Db } from "#shared/db/prisma";
import { toDomain, type User } from "#features/users/domain/user";
import { DB } from "#shared/tokens";

export class GetUserByIdQuery {
  constructor(public readonly id: string) {}
}

// WHY: No @Workflow decorator — the gRPC surface opens its own SERVER span via
// withGrpcServerSpan, and a second workflow span around the same call would nest
// one INTERNAL span inside it for no signal.
@QueryHandler(GetUserByIdQuery)
export class GetUserByIdHandler implements IQueryHandler<GetUserByIdQuery> {
  constructor(@Inject(DB) private readonly db: Db) {}

  // Accepts a `usr_` id OR a Cognito sub — the caller may hold either.
  async execute({ id }: GetUserByIdQuery): Promise<User | null> {
    const row = await this.db.user.findByIdOrCognitoSub(id);
    return row ? toDomain(row as never) : null;
  }
}
