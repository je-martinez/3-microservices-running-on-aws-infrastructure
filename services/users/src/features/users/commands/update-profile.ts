import type { Db } from "#shared/db/prisma";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { toDomain, type User } from "../domain/user.ts";

export interface UpdateProfileInput {
  fullName?: string;
  address?: unknown;
  phoneNumber?: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class UpdateProfileCommand {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async execute(userId: string, input: UpdateProfileInput): Promise<User | null> {
    // Prisma's `update` requires a unique `where` (no `OR`), so resolve the
    // target via the id-or-cognitoSub model method first, then update by its
    // resolved id.
    const target = await this.db.user.findByIdOrCognitoSub(userId);
    if (!target) return null;

    // `updatedBy` is stamped by the audit query extension from the ALS actor.
    // The per-request `onRequest` hook (see `routes.ts`) sets that actor to the
    // caller's `x-user-id` for identity RESOLUTION, but this self-service write
    // overrides it locally to the semantic `users_api:update_profile` value —
    // the audit columns record the action, not the acting user's id (which is
    // known from the request / the row itself). See [[audit-fields]].
    const row = await runAsActor(AuditActor.UpdateProfile, () =>
      this.db.user.update({
        where: { id: target.id },
        data: {
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.address !== undefined ? { address: input.address as any } : {}),
          ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
        },
      }),
    );
    return toDomain(row as any);
  }
}
