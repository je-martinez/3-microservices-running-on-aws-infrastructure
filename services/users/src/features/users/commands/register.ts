import type { PrismaClient } from "../../../generated/prisma/client.js";
import type { AuthProvider } from "../../../shared/auth/auth-provider.js";
import type { EventPublisher } from "../../../shared/messaging/event-publisher.js";
import { newUserId } from "../../../shared/id/nano-id.js";
import { stampCreate } from "../../../shared/audit/audit.js";
import { toDomain, type User } from "../domain/user.js";

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  address?: unknown;
  phoneNumber?: string;
  e2eSource: boolean;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode):
// `new RegisterUserCommand(cradle)` — property names must match cradle keys.
export class RegisterUserCommand {
  private readonly writer: PrismaClient;
  private readonly auth: AuthProvider;
  private readonly events: EventPublisher;

  constructor({ writer, auth, events }: { writer: PrismaClient; auth: AuthProvider; events: EventPublisher }) {
    this.writer = writer;
    this.auth = auth;
    this.events = events;
  }

  async execute(input: RegisterInput): Promise<User> {
    await this.auth.signUp(input.email, input.password);
    const id = newUserId();
    const tags = input.e2eSource ? ["E2E Source"] : [];
    const row = await this.writer.user.create({
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
    await this.events.publishUserCreated({ id, email: input.email });
    return toDomain(row as any);
  }
}
