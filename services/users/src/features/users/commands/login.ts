import type { AuthProvider, AuthTokens } from "#shared/auth/auth-provider";
import type { Db } from "#shared/db/prisma";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";

export interface LoginInput {
  email: string;
  password: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class LoginUserCommand {
  private readonly auth: AuthProvider;
  private readonly db: Db;

  constructor({ auth, db }: { auth: AuthProvider; db: Db }) {
    this.auth = auth;
    this.db = db;
  }

  async execute(input: LoginInput): Promise<AuthTokens> {
    // Only email_hash goes in the CONTEXT — context fields stick to every
    // later line of the request, including `request completed`. The plaintext
    // email is passed per-call-site instead, so it appears on the auth-flow
    // lines and nowhere else.
    setLogContext({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "login_started", email: maskEmail(input.email) },
      "Starting user login",
    );

    // The passwordless guard. Cognito still holds a random, never-revealed
    // password for a PASSWORDLESS user (register-passwordless.ts generates and
    // discards it), so relying on "nobody knows it" alone would be cosmetic —
    // this check makes the property structural by rejecting BEFORE any Cognito
    // call. It costs one DB round-trip on every login; that is accepted.
    //
    // DO NOT "fix" this into a 403: the response is deliberately the SAME
    // generic 401 invalid_credentials a wrong password gets. Per
    // docs/domains/users/decisions/auth-error-mapping.md's anti-enumeration
    // rule, a distinct status or code here would let a caller confirm an
    // account exists AND learn it is passwordless from the response alone. The
    // real cause is recorded ONLY in the log, as reason: "passwordless_user".
    const existing = await this.db.user.findUnique({ where: { email: input.email } });
    if (existing?.authType === "PASSWORDLESS") {
      appLogger.error(
        {
          app_event: "login_failed",
          email: maskEmail(input.email),
          reason: "passwordless_user",
        },
        "User login failed: account is passwordless",
      );
      throw new InvalidCredentialsError();
    }

    try {
      const tokens = await this.auth.login(input.email, input.password);
      // NOTE: `tokens` is deliberately NOT logged — access and refresh tokens
      // are credentials, exactly like the password.
      appLogger.info(
        { app_event: "login_succeeded", email: maskEmail(input.email) },
        "User login completed",
      );
      return tokens;
    } catch (err) {
      // Distinguished here rather than in the route's error handler, which sees
      // only a typed error with no memory of the step that produced it. Wrong
      // credentials and a broken identity provider are different operational
      // problems and should not read identically in the log stream.
      const invalid = err instanceof InvalidCredentialsError;
      appLogger.error(
        {
          err,
          app_event: "login_failed",
          email: maskEmail(input.email),
          reason: invalid ? "invalid_credentials" : "cognito_error",
        },
        invalid
          ? "User login failed: invalid credentials"
          : "User login failed: the identity provider rejected the request",
      );
      throw err; // rethrown untouched — the HTTP contract is unchanged
    }
  }
}
