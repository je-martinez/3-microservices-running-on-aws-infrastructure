import type { PrismaClient } from "@prisma/client";
import { toDomain, type User } from "../domain/user.js";

// Constructor-injected from the Awilix cradle (PROXY injection mode).
// Groups the read-only user lookups (getMe, getUserById) since both share the
// same reader-backed, soft-delete-aware query shape.
export class UserQueryService {
  private readonly reader: PrismaClient;

  constructor({ reader }: { reader: PrismaClient }) {
    this.reader = reader;
  }

  async getMe(userId: string): Promise<User | null> {
    const row = await this.reader.user.findFirst({ where: { id: userId, deletedAt: null } });
    return row ? toDomain(row as any) : null;
  }

  async getUserById(id: string): Promise<User | null> {
    const row = await this.reader.user.findFirst({ where: { id, deletedAt: null } });
    return row ? toDomain(row as any) : null;
  }
}
