import type { PrismaClient } from "@prisma/client";
import { toDomain, type User } from "../domain/user.js";

export async function getUserById(deps: { reader: PrismaClient }, id: string): Promise<User | null> {
  const row = await deps.reader.user.findFirst({ where: { id, deletedAt: null } });
  return row ? toDomain(row as any) : null;
}
