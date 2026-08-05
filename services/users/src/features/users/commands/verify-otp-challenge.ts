import type { AuthProvider, AuthTokens } from "#shared/auth/auth-provider";
import { InvalidOtpError } from "#shared/auth/auth-errors";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";

export interface VerifyOtpChallengeInput {
  email: string;
  session: string;
  code: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class VerifyOtpChallengeCommand {
  private readonly auth: AuthProvider;

  constructor({ auth }: { auth: AuthProvider }) {
    this.auth = auth;
  }

  async execute(input: VerifyOtpChallengeInput): Promise<AuthTokens> {
    setLogContext({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "otp_verify_started", email: maskEmail(input.email) },
      "Starting OTP verification",
    );

    try {
      // NEVER LOG `input.code` — not masked, not hashed, not truncated, and
      // never inside a `reason` string. A 6-digit code has only 1,000,000
      // possibilities, so unlike an email no partial reveal is safe, and it is
      // a live credential for its whole TTL. `input.session` is withheld for
      // the same reason: it is what buys tokens.
      const tokens = await this.auth.respondToOtpChallenge(
        input.email,
        input.session,
        input.code,
      );
      // NOTE: `tokens` is deliberately NOT logged — access and refresh tokens
      // are credentials, exactly like the code that produced them.
      appLogger.info(
        { app_event: "otp_verify_succeeded", email: maskEmail(input.email) },
        "OTP verification completed",
      );
      return tokens;
    } catch (err) {
      const invalid = err instanceof InvalidOtpError;
      appLogger.error(
        {
          err,
          app_event: "otp_verify_failed",
          email: maskEmail(input.email),
          reason: invalid ? "invalid_otp" : "cognito_error",
        },
        invalid
          ? "OTP verification failed: invalid or expired code"
          : "OTP verification failed: the identity provider rejected the request",
      );
      throw err; // rethrown untouched — the HTTP contract is unchanged
    }
  }
}
