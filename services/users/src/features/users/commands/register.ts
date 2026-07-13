import type { Db } from "#shared/db/prisma";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { EventPublisher } from "#shared/messaging/event-publisher";
import type { Env } from "#shared/config/env";
import { MODEL_ID_PREFIXES, generateId } from "#shared/id/nano-id";
import { runAsActor } from "#shared/audit/actor-context";
import { toDomain, type User } from "../domain/user.ts";
import type { CaptureCognitoIdentityCommand } from "../webhooks/capture-cognito-identity.ts";

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
  private readonly env: Env;
  private readonly captureCognitoIdentityCommand: CaptureCognitoIdentityCommand;

  constructor({
    db,
    auth,
    events,
    env,
    captureCognitoIdentityCommand,
  }: {
    db: Db;
    auth: AuthProvider;
    events: EventPublisher;
    env: Env;
    captureCognitoIdentityCommand: CaptureCognitoIdentityCommand;
  }) {
    this.db = db;
    this.auth = auth;
    this.events = events;
    this.env = env;
    this.captureCognitoIdentityCommand = captureCognitoIdentityCommand;
  }

  async execute(input: RegisterInput): Promise<User> {
    // Self-registration: the new row is its own audit actor. The id is
    // reserved up front (instead of letting the nano-id extension generate
    // it) so it can be used both as the row's `id` and, via `runAsActor`, as
    // the actor the audit extension reads from AsyncLocalStorage for this
    // `create` call — stamping `createdBy`/`updatedBy` as the new user's own id
    // (see [[audit-fields]] and `shared/audit/actor-context.ts`). It is also
    // passed to `signUp` as `appUserId` so it lands in Cognito's
    // `custom:app_user_id` attribute before the row even exists.
    const id = generateId(MODEL_ID_PREFIXES.User);
    const signUp = await this.auth.signUp(input.email, input.password, id);
    const tags = input.e2eSource ? ["E2E Source"] : [];
    const row = await runAsActor(id, () =>
      this.db.user.create({
        data: {
          id,
          email: input.email,
          cognitoSub: signUp.sub,
          fullName: input.fullName,
          address: (input.address as any) ?? null,
          phoneNumber: input.phoneNumber ?? null,
          tags,
        },
      }),
    );

    // Spec D2 + D7. Cognito never invokes its Lambda triggers on the local
    // emulator (ADR-0017), so outside production we synthesize the same event
    // and drive the same command the prod webhook route delegates to. In
    // production the Lambda shim owns this — calling it here too would be a
    // double capture (harmless: D4's derived message_id dedupes it). This
    // must run AFTER the user row above is created: users_cognito_data.user_id
    // is a NOT NULL FK to users.id, and the command looks the user up by email.
    //
    // Best-effort (spec D3): identity capture is a secondary snapshot, never a
    // precondition for registration. A failure is logged, not propagated.
    if (this.env.NODE_ENV !== "production") {
      try {
        await this.captureCognitoIdentityCommand.execute({
          version: "1",
          triggerSource: "PostConfirmation_ConfirmSignUp",
          region: this.env.AWS_REGION,
          userPoolId: signUp.userPoolId,
          userName: input.email,
          callerContext: { awsSdkVersion: "local", clientId: signUp.clientId },
          request: {
            userAttributes: {
              sub: signUp.sub,
              email: signUp.email,
              ...(signUp.emailVerified ? { email_verified: signUp.emailVerified } : {}),
            },
          },
        });
      } catch (err) {
        console.error("cognito identity capture failed (non-fatal)", err);
      }
    }

    await this.events.publishUserCreated({ id, email: input.email });
    return toDomain(row as any);
  }
}
