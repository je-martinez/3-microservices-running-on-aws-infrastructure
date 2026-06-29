import type { PrismaClient } from "@prisma/client";
import { toDomain, type User } from "../domain/user.js";

export interface ReaderDeps {
  reader: PrismaClient;
}

export async function getMe(deps: ReaderDeps, userId: string): Promise<User | null> {
  const row = await deps.reader.user.findFirst({ where: { id: userId, deletedAt: null } });
  return row ? toDomain(row as any) : null;
}
