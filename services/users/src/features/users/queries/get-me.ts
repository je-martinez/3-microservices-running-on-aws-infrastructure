import type { PrismaClient } from "@prisma/client";
import { toDomain, type User } from "../domain/user.js";

export interface ReaderDeps { reader: PrismaClient }

export async function getMe(deps: ReaderDeps, userEmail: string): Promise<User | null> {
  // x-user-id carries the user's email (injected by the API Gateway authorizer).
  const row = await deps.reader.user.findFirst({
    where: { email: userEmail, deletedAt: null },
  });
  return row ? toDomain(row as any) : null;
}
