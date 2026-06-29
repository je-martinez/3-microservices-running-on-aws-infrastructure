import type { PrismaClient } from "@prisma/client";
import { toDomain, type User } from "../domain/user.js";

export interface UpdateProfileInput {
  fullName?: string;
  address?: unknown;
  phoneNumber?: string;
}

export async function updateProfile(
  deps: { writer: PrismaClient },
  userId: string,
  input: UpdateProfileInput,
): Promise<User> {
  const row = await deps.writer.user.update({
    where: { id: userId },
    data: {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.address !== undefined ? { address: input.address as any } : {}),
      ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
      updatedBy: userId,
    },
  });
  return toDomain(row as any);
}
