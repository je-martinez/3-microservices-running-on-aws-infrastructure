import type { Db } from "#shared/db/prisma";
import { toDomain, type User } from "../domain/user.ts";
import { byIdOrCognitoSub } from "../queries/get-me.ts";

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
    // target id via id∨cognitoSub first, then update by that unique id.
    const target = await this.db.user.findFirst({
      where: byIdOrCognitoSub(userId),
      select: { id: true },
    });
    if (!target) return null;

    // `updatedBy` is stamped by the audit query extension from the
    // AsyncLocalStorage actor populated per-request (see `routes.ts`).
    const row = await this.db.user.update({
      where: { id: target.id },
      data: {
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.address !== undefined ? { address: input.address as any } : {}),
        ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
      },
    });
    return toDomain(row as any);
  }
}
