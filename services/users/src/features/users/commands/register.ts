import type { PrismaClient } from "@prisma/client";
import type { AuthProvider } from "../../../shared/auth/auth-provider.js";
import type { EventPublisher } from "../../../shared/messaging/event-publisher.js";
import { newUserId } from "../../../shared/id/nano-id.js";
import { stampCreate } from "../../../shared/audit/audit.js";
import { toDomain, type User } from "../domain/user.js";

export interface RegisterDeps {
  writer: PrismaClient;
  auth: AuthProvider;
  events: EventPublisher;
}

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  address?: unknown;
  phoneNumber?: string;
  e2eSource: boolean;
}

export async function registerUser(deps: RegisterDeps, input: RegisterInput): Promise<User> {
  await deps.auth.signUp(input.email, input.password);
  const id = newUserId();
  const tags = input.e2eSource ? ["E2E Source"] : [];
  const row = await deps.writer.user.create({
    data: {
      id,
      email: input.email,
      fullName: input.fullName,
      address: (input.address as any) ?? null,
      phoneNumber: input.phoneNumber ?? null,
      tags,
      ...stampCreate(id),
    },
  });
  await deps.events.publishUserCreated({ id, email: input.email });
  return toDomain(row as any);
}
