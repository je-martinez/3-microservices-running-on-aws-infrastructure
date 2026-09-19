import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { CurrentUser } from "#shared/auth/current-user";
import type { Db } from "#shared/db/prisma";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { DB } from "#shared/tokens";
import { RoutineFailure, Workflow } from "#shared/observability/workflow-metadata";
import { toDomain, type User } from "#features/users/domain/user";

export interface UpdateProfileInput {
  fullName?: string;
  address?: unknown;
  phoneNumber?: string;
}

export class UpdateProfileCommand {
  constructor(
    public readonly currentUser: CurrentUser,
    public readonly input: UpdateProfileInput,
  ) {}
}

@Workflow("update_profile")
@CommandHandler(UpdateProfileCommand)
export class UpdateProfileHandler implements ICommandHandler<UpdateProfileCommand> {
  constructor(@Inject(DB) private readonly db: Db) {}

  async execute({
    currentUser,
    input,
  }: UpdateProfileCommand): Promise<User | RoutineFailure> {
    const target = await currentUser.resolve();
    if (!target) {
      appLogger.warn(
        { app_event: "update_profile_failed", reason: "unknown_user" },
        "Profile update failed: the caller resolved to no user",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "update_profile_failed", reason: "unknown_user" });
      return new RoutineFailure("unknown_user");
    }

    // CONTRACT: Keep the await INSIDE runAsActor — Prisma promises are lazy.
    // See [[2026-07-12-prisma-lazy-promise-als]]
    const row = await runAsActor(AuditActor.UpdateProfile, () =>
      this.db.user.update({
        where: { id: target.id },
        data: {
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.address !== undefined ? { address: input.address as never } : {}),
          ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
        },
      }),
    );
    return toDomain(row as never);
  }
}
