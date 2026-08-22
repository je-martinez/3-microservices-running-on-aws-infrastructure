import type { Db } from "#shared/db/prisma";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { ResetCodeStore } from "#shared/cache/reset-code-store";
import type { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { InvalidResetCodeError } from "#shared/auth/auth-errors";
import { trace } from "@opentelemetry/api";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";

export interface ConfirmPasswordResetInput {
  email: string;
  code: string;
  newPassword: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
//
// Step 2 of the self-owned password reset: verify OUR code against OUR store,
// then apply the password with Cognito's AdminSetUserPassword. Cognito's
// ConfirmForgotPassword is not involved — it only accepts codes Cognito itself
// minted (a service-minted one yields CodeMismatchException, verified).
export class ConfirmPasswordResetCommand {
  private readonly db: Db;
  private readonly auth: AuthProvider;
  private readonly resetCodeStore: ResetCodeStore;
  private readonly metrics: MetricsPublisher;

  constructor({
    db,
    auth,
    resetCodeStore,
    metricsPublisher,
  }: {
    db: Db;
    auth: AuthProvider;
    resetCodeStore: ResetCodeStore;
    metricsPublisher: MetricsPublisher;
  }) {
    this.db = db;
    this.auth = auth;
    this.resetCodeStore = resetCodeStore;
    this.metrics = metricsPublisher;
  }

  // NEVER put `input.code` or `input.newPassword` on a span attribute. Both are
  // live credentials and a span is exported exactly like a log line, so the
  // rule the log call sites below follow applies here unchanged.
  async execute(input: ConfirmPasswordResetInput): Promise<void> {
    return withWorkflowSpan(
      "password_reset_confirm",
      { app_event: "password_reset_confirm_started", email_hash: hashEmail(input.email) },
      () => this.doExecute(input),
    );
  }

  private async doExecute(input: ConfirmPasswordResetInput): Promise<void> {
    setLogContext({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "password_reset_confirm_started", email: maskEmail(input.email) },
      "Starting password reset confirmation",
    );

    // Every rejection below throws the SAME InvalidResetCodeError: unknown
    // email, no outstanding code, expired code, wrong code. The caller cannot
    // tell them apart, which is what keeps the enumeration property established
    // by /password/forgot intact — an endpoint that answered "no such account"
    // here would undo it. The distinguishing detail goes on the log line's
    // `reason`, for operators only.
    //
    // The user is loaded FIRST because the flag-clearing write below needs the
    // id, and the store is keyed by email. An unknown email is rejected with the
    // same error as a bad code, and no code is ever verified for it.
    const user = await this.db.user.findFirst({ where: { email: input.email } });
    if (!user) {
      this.reject(input.email, "unknown_email");
    }

    setLogContext({ user_id: user!.id });

    // Single call: verifies against the hash in Redis (constant-time) and
    // DELETES the key on success, which is what makes the code single-use.
    //
    // "Expired" needs no branch here — Redis has already removed the key, so an
    // expired code arrives as the same `false` a missing one does. That collapse
    // is deliberate and matches what the API exposes anyway; the price is that
    // the log line cannot separate `expired_code` from `code_mismatch` the way
    // the table version could, which is a trade the native TTL is worth.
    const accepted = await this.resetCodeStore.verifyAndConsume(input.email, input.code);
    if (!accepted) {
      this.reject(input.email, "invalid_or_expired_code");
    }

    // ==== ORDERING: the code is consumed BEFORE Cognito is called ====
    // This is forced by the store's atomic verify-and-delete and is the one
    // behaviour that differs from the Postgres version, which applied the
    // password first so a Cognito failure left the code reusable. Here a Cognito
    // failure burns the code and the user must request a new one.
    //
    // Accepted on purpose: the alternative — verify, call Cognito, then delete —
    // leaves a verified code live across a network call, so two concurrent
    // requests could both pass verification, and a crash in between would leave
    // a usable code for the rest of its TTL. Trading a rare "request another
    // code" for a closed replay window is the right way round for a credential.
    await this.auth.setPassword(input.email, input.newPassword);

    // Clears the forced-change flag if it was set: the user has just chosen a
    // password of their own, which is exactly what the flag was demanding.
    // Written unconditionally rather than read-then-write — setting false on a
    // row that is already false costs one statement and avoids a read.
    await runAsActor(AuditActor.PasswordResetConfirmed, () =>
      this.db.user.update({
        where: { id: user!.id },
        data: { mustChangePassword: false },
      }),
    );

    // Mirror the cleared flag onto Cognito so the next token carries
    // must_change_password=false. Best-effort for the same reason as in
    // change-password.ts: the password and the column are already written, and
    // GET /v1/users/me answers from the column, not the token.
    try {
      await this.auth.setMustChangePassword(input.email, false);
    } catch (err) {
      appLogger.warn(
        {
          err,
          app_event: "must_change_password_mirror_failed",
          email: maskEmail(input.email),
          user_id: user!.id,
        },
        "Could not mirror mustChangePassword to Cognito (non-fatal): the token claim stays stale until the next write",
      );
    }

    // NEVER log the code or the new password.
    appLogger.info(
      {
        app_event: "password_reset_confirm_succeeded",
        email: maskEmail(input.email),
        user_id: user!.id,
      },
      "Password reset confirmed and new password applied",
    );
    trace.getActiveSpan()?.setAttributes({
      app_event: "password_reset_confirm_succeeded",
      user_id: user!.id,
    });

    // Counted on CONFIRM, not on request: /password/forgot answers 202 even for an
    // unknown email (deliberate non-enumeration), so counting requests there would
    // count resets that never happened. Reaching this line means a password was
    // actually changed. The call never throws (see MetricsPublisher).
    await this.metrics.publish("password_resets_total", 1, { Service: "users" });
  }

  // `never` return type: this always throws, which lets the call sites above
  // read as guards without TypeScript losing track of the narrowing.
  private reject(email: string, reason: string): never {
    appLogger.warn(
      { app_event: "password_reset_confirm_failed", email: maskEmail(email), reason },
      "Password reset confirmation rejected",
    );
    // Set on the span from the SAME place the log line is written, so the two
    // can never drift apart across the two rejection branches (`unknown_email`
    // and `invalid_or_expired_code`) that share this helper. The reason names
    // the class of rejection only — never the submitted code.
    trace
      .getActiveSpan()
      ?.setAttributes({ app_event: "password_reset_confirm_failed", reason });
    throw new InvalidResetCodeError();
  }
}
