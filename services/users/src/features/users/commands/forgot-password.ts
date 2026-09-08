import type { Db } from "#shared/db/prisma";
import type { EventPublisher } from "#shared/messaging/event-publisher";
import type { ResetCodeStore } from "#shared/cache/reset-code-store";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { generateResetCode, RESET_CODE_TTL_SECONDS } from "#shared/auth/reset-code";
import { trace } from "@opentelemetry/api";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";

export interface ForgotPasswordInput {
  email: string;
}

// Step 1 of the SELF-OWNED password reset — Cognito's ForgotPassword is not used
// anywhere in this flow (it emails a code it never reveals and accepts only its own).
// WARNING: This service therefore custodies a live credential. The code is stored
// HASHED and is never logged; it lives in Redis, not Postgres, so it expires natively.
export class ForgotPasswordCommand {
  private readonly db: Db;
  private readonly events: EventPublisher;
  private readonly resetCodeStore: ResetCodeStore;

  constructor({
    db,
    events,
    resetCodeStore,
  }: {
    db: Db;
    events: EventPublisher;
    resetCodeStore: ResetCodeStore;
  }) {
    this.db = db;
    this.events = events;
    this.resetCodeStore = resetCodeStore;
  }

  // WARNING: Never put the minted `code` on a span attribute — a span reaches a
  // backend exactly as a log line does. Use `email_hash`, never the email.
  // CONTRACT: The unknown-email branch is marked a SUCCESS with
  // `reason: unknown_email`, not an error — anything else rebuilds the enumeration
  // oracle in the trace backend instead of the response. See [[logging-context]]
  async execute(input: ForgotPasswordInput): Promise<void> {
    return withWorkflowSpan(
      "password_reset_requested",
      { app_event: "password_reset_requested_started", email_hash: hashEmail(input.email) },
      () => this.doExecute(input),
    );
  }

  private async doExecute(input: ForgotPasswordInput): Promise<void> {
    // Only email_hash goes in the CONTEXT — context fields stick to every later
    // line of the request, including `request completed`. The masked email is
    // passed per call site instead, so it appears on the auth-flow lines only.
    setLogContext({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "password_reset_requested_started", email: maskEmail(input.email) },
      "Starting password reset request",
    );

    const user = await this.db.user.findFirst({ where: { email: input.email } });

    // CONTRACT: Do NOT turn this into a 404. An unknown email must answer with the
    // same status and body as a known one; any distinguishable response is a free
    // oracle for "does this person have an account here". The absence is recorded in
    // the logs, where only operators see it. The same rule governs
    // /v1/users/password/confirm, where an unknown email and a wrong code are both
    // `invalid_reset_code`.
    if (!user) {
      appLogger.info(
        {
          app_event: "password_reset_requested_succeeded",
          email: maskEmail(input.email),
          reason: "unknown_email",
        },
        "Password reset request accepted for an unknown email (no code minted, no event published)",
      );
      trace.getActiveSpan()?.setAttributes({
        app_event: "password_reset_requested_succeeded",
        reason: "unknown_email",
      });
      return;
    }

    setLogContext({ user_id: user.id });

    const code = generateResetCode();

    // CONTRACT: Only the HASH is stored. The plaintext code lives in memory for this
    // method and travels exactly once, to the email pipeline. One key per email, so
    // this SET replaces any outstanding code and two can never be live at once. No
    // `runAsActor` here — it stamps Prisma's audit columns, and this write never
    // reaches Postgres.
    await this.resetCodeStore.store(input.email, code);

    // CONTRACT: Keep this try/catch — it is NOT redundant with the publisher's own
    // swallow. That one covers the SQS send; this covers the publish call failing for
    // ANY reason. The guarantee is a SECURITY one: a publish error surfacing as a 500
    // can only happen for an email that EXISTS, rebuilding the enumeration oracle.
    // `ttlSeconds` is passed, not recomputed, so the email and Redis agree.
    try {
      await this.events.publishPasswordResetRequested({
        userId: user.id,
        email: input.email,
        fullName: user.fullName,
        code,
        ttlSeconds: RESET_CODE_TTL_SECONDS,
        ...(user.cognitoSub ? { cognitoSub: user.cognitoSub } : {}),
      });
    } catch (err) {
      // NEVER log `code` (the credential) and never a plaintext email — `err`
      // is a publisher error and carries neither.
      appLogger.error(
        {
          err,
          app_event: "password_reset_requested_publish_failed",
          reason: "publish_threw",
          user_id: user.id,
        },
        "PASSWORD_RESET_REQUESTED publish failed (non-fatal): the code was stored but no email was requested",
      );
    }

    // NEVER log `code`, and never the expiry in a form that narrows it — the
    // TTL is a constant, so `ttl_seconds` reveals nothing the source does not.
    appLogger.info(
      {
        app_event: "password_reset_requested_succeeded",
        email: maskEmail(input.email),
        user_id: user.id,
        ttl_seconds: RESET_CODE_TTL_SECONDS,
      },
      "Password reset code minted and event published",
    );
    trace.getActiveSpan()?.setAttributes({
      app_event: "password_reset_requested_succeeded",
      user_id: user.id,
    });
  }
}
