import type { Db } from "#shared/db/prisma";
import type { EventPublisher } from "#shared/messaging/event-publisher";
import type { ResetCodeStore } from "#shared/cache/reset-code-store";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { generateResetCode, RESET_CODE_TTL_SECONDS } from "#shared/auth/reset-code";

export interface ForgotPasswordInput {
  email: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
//
// Step 1 of the SELF-OWNED password reset. Cognito's own ForgotPassword is not
// used anywhere in this flow: it emails a code it never reveals to the caller,
// its CustomMessage trigger does not fire on this substrate, and it accepts only
// its own code at ConfirmForgotPassword. So this service mints, stores, verifies
// and applies the change itself, and accepts the tradeoff that it now custodies
// a short-lived credential — which is why the code is stored HASHED (see
// `shared/auth/reset-code.ts`) and never logged.
//
// The code lives in REDIS, not in Postgres: it is a ten-minute secret that must
// expire on its own, which Redis does natively (`EX`). See `ResetCodeStore`.
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

  async execute(input: ForgotPasswordInput): Promise<void> {
    // Only email_hash goes in the CONTEXT — context fields stick to every later
    // line of the request, including `request completed`. The masked email is
    // passed per call site instead, so it appears on the auth-flow lines only.
    setLogContext({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "password_reset_requested_started", email: maskEmail(input.email) },
      "Starting password reset request",
    );

    const user = await this.db.user.findFirst({ where: { email: input.email } });

    // ==== NO USER ENUMERATION — DO NOT "FIX" THIS INTO A 404 ====
    //
    // An unknown email returns here and the route answers exactly as it does for
    // a known one: same status, same body, no timing-visible extra work worth
    // measuring. This is a SECURITY PROPERTY, not an oversight or a missing
    // error case. Turning it into a 404 (or any distinguishable response) hands
    // an attacker a free oracle for "does this person have an account here",
    // which is precisely what the whole endpoint is otherwise careful not to
    // leak. The absence is recorded in the LOGS, where only operators see it.
    //
    // The same reasoning governs POST /v1/users/password/confirm: an unknown
    // email and a wrong code are both `invalid_reset_code`.
    if (!user) {
      appLogger.info(
        {
          app_event: "password_reset_requested_succeeded",
          email: maskEmail(input.email),
          reason: "unknown_email",
        },
        "Password reset request accepted for an unknown email (no code minted, no event published)",
      );
      return;
    }

    setLogContext({ user_id: user.id });

    const code = generateResetCode();

    // Only the HASH is stored (inside `store`). The plaintext code exists in
    // memory for the length of this method and travels exactly once, to the
    // email pipeline.
    //
    // One key per email, so this SET necessarily replaces any code still
    // outstanding — a second request invalidates the first, and two codes can
    // never be live at once multiplying the guessing surface. In the Postgres
    // version that took an explicit "consume the old rows" write; here it falls
    // out of the key space, with no way to forget it.
    //
    // Redis expires the key itself after RESET_CODE_TTL_SECONDS, which is the
    // whole reason this is not a table: no `expires_at` comparison at read time
    // and no cleanup job. There is also no audit actor wrapped around this call
    // — `runAsActor` stamps Prisma's audit columns, and this write never reaches
    // Postgres.
    await this.resetCodeStore.store(input.email, code);

    // Best-effort, exactly like USER_CREATED: a queue outage costs the user
    // their email rather than turning a stored code into an HTTP error.
    //
    // The try/catch is NOT redundant with the publisher's own swallow-and-log.
    // The publisher handles the SQS send failing; this handles the publish call
    // failing for ANY reason (a serialization throw, a credentials error raised
    // before the send, a future publisher that forgets the convention). The
    // guarantee that matters here is a SECURITY one, not a reliability one: a
    // publish error surfacing as a 500 could only ever happen for an email that
    // EXISTS, which turns this endpoint back into the enumeration oracle the
    // whole flow is built to avoid. So the swallow is enforced at the boundary
    // that owns the property, not delegated to a collaborator's good behaviour.
    //
    // `ttlSeconds` is passed rather than recomputed downstream so the number the
    // email prints and the TTL Redis actually enforces come from one value.
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
  }
}
