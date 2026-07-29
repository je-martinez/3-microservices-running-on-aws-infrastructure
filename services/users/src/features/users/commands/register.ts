import type { Db } from "#shared/db/prisma";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { EventPublisher } from "#shared/messaging/event-publisher";
import type { Env } from "#shared/config/env";
import { MODEL_ID_PREFIXES, generateId } from "#shared/id/nano-id";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { EmailAlreadyExistsError } from "#shared/auth/auth-errors";
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
    // Only email_hash goes in the CONTEXT — context fields stick to every
    // later line of the request, including `request completed`. The plaintext
    // email is passed per-call-site instead, so it appears on the auth-flow
    // lines and nowhere else. (Putting it in the context leaked it onto every
    // request log; caught by the PII check in JE-77's acceptance criteria.)
    setLogContext({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "register_started", email: maskEmail(input.email) },
      "Starting user registration",
    );

    // Self-registration: the new row is its own audit actor. The id is
    // reserved up front (instead of letting the nano-id extension generate it)
    // so it can be used as both the row's `id` and the `appUserId` passed to
    // `signUp` (landing in Cognito's `custom:app_user_id` before the row
    // exists). The audit actor is NOT this id: the `create` runs inside
    // `runAsActor(AuditActor.Register, ...)`, so the extension stamps
    // `createdBy`/`updatedBy` with the semantic `users_api:register` value
    // rather than the user's own id (see [[audit-fields]], `AuditActor`).
    const id = generateId(MODEL_ID_PREFIXES.User);

    // The failure branches are distinguished HERE rather than in the route's
    // error handler: by the time an error reaches `setErrorHandler` it is just
    // a typed error with no memory of which step produced it, and "Cognito
    // rejected the signup" versus "the database write failed" are different
    // operational problems. Each branch rethrows untouched, so the HTTP
    // contract (409 email_exists, etc.) is unchanged.
    let signUp;
    try {
      signUp = await this.auth.signUp(input.email, input.password, id);
    } catch (err) {
      appLogger.error(
        {
          err,
          app_event: "register_failed",
          email: maskEmail(input.email),
          reason: err instanceof EmailAlreadyExistsError ? "duplicate_email" : "cognito_error",
        },
        err instanceof EmailAlreadyExistsError
          ? "User registration failed: a user with this email already exists"
          : "User registration failed: could not create the user in Cognito",
      );
      throw err;
    }

    const tags = input.e2eSource ? ["E2E Source"] : [];
    let row;
    try {
      row = await runAsActor(AuditActor.Register, () =>
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
    } catch (err) {
      appLogger.error(
        { err, app_event: "register_failed", email: maskEmail(input.email), reason: "database_error" },
        "User registration failed: could not persist the user",
      );
      throw err;
    }

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
        appLogger.warn(
          { err, app_event: "cognito_identity_capture_failed" },
          "cognito identity capture failed (non-fatal)",
        );
      }
    }

    await this.events.publishUserCreated({ id, email: input.email });

    // Enrich the context so every LATER line of this request carries the id too.
    setLogContext({ user_id: id });
    appLogger.info(
      { app_event: "register_succeeded", email: maskEmail(input.email), user_id: id },
      "User registration completed",
    );

    return toDomain(row as any);
  }
}
