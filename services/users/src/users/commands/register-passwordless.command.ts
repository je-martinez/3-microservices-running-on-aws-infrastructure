import { randomBytes } from "node:crypto";
import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { Db } from "#shared/db/prisma";
import type { EventPublisher } from "#shared/messaging/event-publisher";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { MODEL_ID_PREFIXES, generateId } from "#shared/id/nano-id";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { EmailAlreadyExistsError } from "#shared/auth/auth-errors";
import { AUTH_PROVIDER, DB, EVENT_PUBLISHER } from "#shared/tokens";
import { Workflow } from "#shared/observability/workflow-metadata";
import { toDomain, type User } from "#features/users/domain/user";
import { CaptureCognitoIdentityCommand } from "#features/users/webhooks/capture-cognito-identity";

export interface RegisterPasswordlessInput {
  email: string;
  fullName: string;
  address?: unknown;
  phoneNumber?: string;
  e2eSource: boolean;
}

export class RegisterPasswordlessCommand {
  constructor(public readonly input: RegisterPasswordlessInput) {}
}

// CONTRACT: 32 random bytes, base64url — clears Cognito's password-policy minimum.
// Cognito requires every user to have SOME password even on the passwordless path;
// this is discarded right after signUp() returns.
// WARNING: Never logged, never returned, never persisted.
function generateRandomPassword(): string {
  return randomBytes(32).toString("base64url");
}

// WHY: Flow name is distinct from password register so spans do not collide;
// log `app_event`s stay `register_*` — both paths are still registrations.
@Workflow("register_passwordless")
@CommandHandler(RegisterPasswordlessCommand)
export class RegisterPasswordlessHandler implements ICommandHandler<RegisterPasswordlessCommand> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    private readonly metrics: MetricsPublisher,
    private readonly captureCognitoIdentityCommand: CaptureCognitoIdentityCommand,
  ) {}

  async execute({ input }: RegisterPasswordlessCommand): Promise<User> {
    setLogContext({ email_hash: hashEmail(input.email) });
    trace.getActiveSpan()?.setAttributes({
      auth_type: "PASSWORDLESS",
      email_hash: hashEmail(input.email),
    });
    appLogger.info(
      { app_event: "register_started", email: maskEmail(input.email), auth_type: "PASSWORDLESS" },
      "Starting passwordless user registration",
    );

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
      trace.getActiveSpan()?.setAttributes({
        app_event: "register_failed",
        reason: err instanceof EmailAlreadyExistsError ? "duplicate_email" : "cognito_error",
      });
      throw err;
    }

    const tags = input.e2eSource ? ["E2E Source"] : [];
    let row;
    try {
      // CONTRACT: Keep the await INSIDE runAsActor — Prisma promises are lazy.
      // See [[2026-07-12-prisma-lazy-promise-als]]
      row = await runAsActor(AuditActor.RegisterPasswordless, () =>
        this.db.user.create({
          data: {
            id,
            email: input.email,
            cognitoSub: signUp.sub,
            fullName: input.fullName,
            address: (input.address as never) ?? null,
            phoneNumber: input.phoneNumber ?? null,
            authType: "PASSWORDLESS",
            tags,
          },
        }),
      );
    } catch (err) {
      appLogger.error(
        {
          err,
          app_event: "register_failed",
          email: maskEmail(input.email),
          reason: "database_error",
        },
        "Passwordless registration failed: could not persist the user",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "register_failed", reason: "database_error" });
      throw err;
    }

    if ((process.env.NODE_ENV ?? "development") !== "production") {
      try {
        await this.captureCognitoIdentityCommand.execute({
          version: "1",
          triggerSource: "PostConfirmation_ConfirmSignUp",
          region: process.env.AWS_REGION ?? "us-east-1",
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

    // CONTRACT: Keep this payload identical to register — a passwordless signup
    // renders the same welcome email. See [[audit-fields]]
    await this.events.publishUserCreated({
      id,
      email: input.email,
      fullName: input.fullName,
      createdAt: (row as { createdAt: Date }).createdAt,
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
    trace.getActiveSpan()?.setAttributes({ app_event: "register_succeeded", user_id: id });

    await this.metrics.publish("users_registered_total", 1, { Service: "users" });

    return toDomain(row as never);
  }
}
