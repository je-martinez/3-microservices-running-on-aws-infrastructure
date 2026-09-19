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

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  address?: unknown;
  phoneNumber?: string;
  e2eSource: boolean;
}

export class RegisterCommand {
  constructor(public readonly input: RegisterInput) {}
}

@Workflow("register")
@CommandHandler(RegisterCommand)
export class RegisterHandler implements ICommandHandler<RegisterCommand> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    private readonly metrics: MetricsPublisher,
    private readonly captureCognitoIdentityCommand: CaptureCognitoIdentityCommand,
  ) {}

  async execute({ input }: RegisterCommand): Promise<User> {
    // Only email_hash goes in the CONTEXT — context fields stick to every
    // later line of the request, including `request completed`. The plaintext
    // email is passed per-call-site instead, so it appears on the auth-flow
    // lines and nowhere else.
    setLogContext({ email_hash: hashEmail(input.email) });
    trace.getActiveSpan()?.setAttributes({
      auth_type: "PASSWORD",
      email_hash: hashEmail(input.email),
    });
    appLogger.info(
      { app_event: "register_started", email: maskEmail(input.email) },
      "Starting user registration",
    );

    // CONTRACT: Reserve the id up front rather than letting the nano-id extension
    // mint it — it is needed as both the row's `id` and the `appUserId` handed to
    // `signUp`, which lands in Cognito before the row exists. The audit actor is NOT
    // this id: `runAsActor(AuditActor.Register, ...)` stamps the semantic
    // `users_api:register` value. See [[audit-fields]]
    const id = generateId(MODEL_ID_PREFIXES.User);

    let signUp;
    try {
      signUp = await this.auth.signUp(input.email, input.password, id, input.fullName);
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
      trace.getActiveSpan()?.setAttributes({
        app_event: "register_failed",
        reason: err instanceof EmailAlreadyExistsError ? "duplicate_email" : "cognito_error",
      });
      throw err;
    }

    const tags = input.e2eSource ? ["E2E Source"] : [];
    let row;
    try {
      // CONTRACT: Keep the await INSIDE runAsActor — Prisma promises are lazy, so
      // an await outside loses the actor and the audit extension writes null.
      // See [[2026-07-12-prisma-lazy-promise-als]]
      row = await runAsActor(AuditActor.Register, () =>
        this.db.user.create({
          data: {
            id,
            email: input.email,
            cognitoSub: signUp.sub,
            fullName: input.fullName,
            address: (input.address as never) ?? null,
            phoneNumber: input.phoneNumber ?? null,
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
        "User registration failed: could not persist the user",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "register_failed", reason: "database_error" });
      throw err;
    }

    // CONTRACT: Run this AFTER the user row is created — users_cognito_data.user_id
    // is a NOT NULL FK to users.id and the command looks the user up by email.
    // Best-effort: identity capture is a secondary snapshot, never a precondition.
    // WHY: Read NODE_ENV/AWS_REGION from process.env — importing AppConfigModule
    // here would run ConfigModule.forRoot and fail unit tests that do not load a
    // full env. Production sets both via the generated service env file.
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

    // CONTRACT: `fullName` and `createdAt` must travel with the event — the pipeline's
    // payload schema rejects an envelope without the first, and the welcome email
    // prints "Member Since" from the second and "Account ID" from `id`.
    // See [[audit-fields]]
    await this.events.publishUserCreated({
      id,
      email: input.email,
      fullName: input.fullName,
      createdAt: (row as { createdAt: Date }).createdAt,
      cognitoSub: signUp.sub,
    });

    setLogContext({ user_id: id });
    appLogger.info(
      { app_event: "register_succeeded", email: maskEmail(input.email), user_id: id },
      "User registration completed",
    );
    trace.getActiveSpan()?.setAttributes({ app_event: "register_succeeded", user_id: id });

    await this.metrics.publish("users_registered_total", 1, { Service: "users" });

    return toDomain(row as never);
  }
}
