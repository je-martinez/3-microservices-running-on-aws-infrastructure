import type { Db } from "../../../shared/db/prisma.js";
import type { AuthProvider } from "../../../shared/auth/auth-provider.js";
import type { EventPublisher } from "../../../shared/messaging/event-publisher.js";
import { MODEL_ID_PREFIXES, generateId } from "../../../shared/id/nano-id.js";
import { runAsActor } from "../../../shared/audit/actor-context.js";
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
  private readonly db: Db;
  private readonly auth: AuthProvider;
  private readonly events: EventPublisher;

  constructor({ db, auth, events }: { db: Db; auth: AuthProvider; events: EventPublisher }) {
    this.db = db;
    this.auth = auth;
    this.events = events;
  }

  async execute(input: RegisterInput): Promise<User> {
    await this.auth.signUp(input.email, input.password);
    // Self-registration: the new row is its own audit actor. The id is
    // reserved up front (instead of letting the nano-id extension generate
    // it) so it can be used both as the row's `id` and, via `runAsActor`, as
    // the actor the audit extension reads from AsyncLocalStorage for this
    // `create` call — stamping `createdBy`/`updatedBy` as the new user's own id
    // (see [[audit-fields]] and `shared/audit/actor-context.ts`).
    const id = generateId(MODEL_ID_PREFIXES.User);
    const tags = input.e2eSource ? ["E2E Source"] : [];
    const row = await runAsActor(id, () =>
      this.db.user.create({
        data: {
          id,
          email: input.email,
          fullName: input.fullName,
          address: (input.address as any) ?? null,
          phoneNumber: input.phoneNumber ?? null,
          tags,
        },
      }),
    );
    await this.events.publishUserCreated({ id, email: input.email });
    return toDomain(row as any);
  }
}
