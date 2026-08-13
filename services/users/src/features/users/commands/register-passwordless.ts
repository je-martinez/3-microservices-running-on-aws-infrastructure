import { randomBytes } from "node:crypto";
import type { Db } from "#shared/db/prisma";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { EventPublisher } from "#shared/messaging/event-publisher";
import type { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
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

export interface RegisterPasswordlessInput {
  email: string;
  fullName: string;
  address?: unknown;
  phoneNumber?: string;
  e2eSource: boolean;
}

// Generates a random password the caller never sees and nothing stores
// retrievably. Cognito requires every user to have SOME password internally
// even on the passwordless path — this is that value, discarded immediately
// after signUp() returns. 32 random bytes, base64url-encoded, comfortably
// clears any password-policy minimum length and character-class requirement
// (base64url mixes upper, lower and digits with overwhelming probability at
// this length). It is never logged, never returned, and never persisted.
function generateRandomPassword(): string {
  return randomBytes(32).toString("base64url");
}

// Constructor-injected from the Awilix cradle (PROXY injection mode):
// `new RegisterPasswordlessCommand(cradle)` — property names must match cradle
// keys. Deliberately mirrors RegisterUserCommand's structure and reuses its
// `register_*` app_events (this is still fundamentally a registration, marked
// by `auth_type`), so the two paths read as siblings rather than divergent
// implementations.
export class RegisterPasswordlessCommand {
  private readonly db: Db;
  private readonly auth: AuthProvider;
  private readonly events: EventPublisher;
  private readonly metrics: MetricsPublisher;
  private readonly env: Env;
  private readonly captureCognitoIdentityCommand: CaptureCognitoIdentityCommand;

  constructor({
    db,
    auth,
    events,
    metricsPublisher,
    env,
    captureCognitoIdentityCommand,
  }: {
    db: Db;
    auth: AuthProvider;
    events: EventPublisher;
    metricsPublisher: MetricsPublisher;
    env: Env;
    captureCognitoIdentityCommand: CaptureCognitoIdentityCommand;
  }) {
    this.db = db;
    this.auth = auth;
    this.events = events;
    this.metrics = metricsPublisher;
    this.env = env;
    this.captureCognitoIdentityCommand = captureCognitoIdentityCommand;
  }

  async execute(input: RegisterPasswordlessInput): Promise<User> {
    setLogContext({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "register_started", email: maskEmail(input.email), auth_type: "PASSWORDLESS" },
      "Starting passwordless user registration",
    );

    // The id is reserved up front so it can be both the row's `id` and the
    // `appUserId` passed to `signUp` (landing in Cognito's `custom:app_user_id`
    // before the row exists) — same as register.ts.
    const id = generateId(MODEL_ID_PREFIXES.User);
    const randomPassword = generateRandomPassword();

    let signUp;
    try {
      signUp = await this.auth.signUp(input.email, randomPassword, id, input.fullName);
    } catch (err) {
      appLogger.error(
        {
          err,
          app_event: "register_failed",
          email: maskEmail(input.email),
          reason: err instanceof EmailAlreadyExistsError ? "duplicate_email" : "cognito_error",
        },
        err instanceof EmailAlreadyExistsError
          ? "Passwordless registration failed: a user with this email already exists"
          : "Passwordless registration failed: could not create the user in Cognito",
      );
      throw err;
    }

    const tags = input.e2eSource ? ["E2E Source"] : [];
    let row;
    try {
      row = await runAsActor(AuditActor.RegisterPasswordless, () =>
        this.db.user.create({
          data: {
            id,
            email: input.email,
            cognitoSub: signUp.sub,
            fullName: input.fullName,
            address: (input.address as any) ?? null,
            phoneNumber: input.phoneNumber ?? null,
            authType: "PASSWORDLESS",
            tags,
          },
        }),
      );
    } catch (err) {
      appLogger.error(
        { err, app_event: "register_failed", email: maskEmail(input.email), reason: "database_error" },
        "Passwordless registration failed: could not persist the user",
      );
      throw err;
    }

    // Best-effort identity capture, same rationale as register.ts: Cognito
    // never invokes its Lambda triggers on the local emulator (ADR-0017), so
    // outside production we synthesize the same event in-process. A failure is
    // logged, not propagated.
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

    // Best-effort by design (the publisher swallows and logs its own failures),
    // so a queue outage never turns a completed registration into an HTTP error.
    //
    // Identical payload to register.ts, deliberately: a passwordless signup
    // produces the same welcome email as a password one, so it must carry the
    // same fields — `id` for the email's "Account ID" row and the created row's
    // `createdAt` for its "Member Since" row. Both come from values already in
    // hand here (the minted id and the row the `create` returned), so there is
    // no extra query on this path either.
    await this.events.publishUserCreated({
      id,
      email: input.email,
      fullName: input.fullName,
      createdAt: (row as any).createdAt,
      cognitoSub: signUp.sub,
    });

    setLogContext({ user_id: id });
    appLogger.info(
      {
        app_event: "register_succeeded",
        email: maskEmail(input.email),
        user_id: id,
        auth_type: "PASSWORDLESS",
      },
      "Passwordless user registration completed",
    );

    // The SAME metric name and the SAME dimensions as register.ts: both paths are
    // registrations. The password/passwordless split is carried by `users_total`'s
    // `HasPassword` dimension, not by a second counter.
    await this.metrics.publish("users_registered_total", 1, { Service: "users" });

    return toDomain(row as any);
  }
}
