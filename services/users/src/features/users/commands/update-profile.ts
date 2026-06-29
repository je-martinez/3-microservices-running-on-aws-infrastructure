import type { PrismaClient } from "@prisma/client";
import { toDomain, type User } from "../domain/user.js";

export interface UpdateProfileInput {
  fullName?: string;
  address?: unknown;
  phoneNumber?: string;
}

export async function updateProfile(
  deps: { writer: PrismaClient },
  userEmail: string,
  input: UpdateProfileInput,
): Promise<User> {
  // x-user-id carries the user's email (injected by the API Gateway authorizer).
  // email is @unique so it can be used directly as the update key.
  const row = await deps.writer.user.update({
    where: { email: userEmail },
    data: {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.address !== undefined ? { address: input.address as any } : {}),
      ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
      updatedBy: userEmail,
    },
  });
  return toDomain(row as any);
}
