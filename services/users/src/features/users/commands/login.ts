import type { AuthProvider, AuthTokens } from "#shared/auth/auth-provider";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";

export interface LoginInput {
  email: string;
  password: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class LoginUserCommand {
  private readonly auth: AuthProvider;

  constructor({ auth }: { auth: AuthProvider }) {
    this.auth = auth;
  }

  async execute(input: LoginInput): Promise<AuthTokens> {
    // Only email_hash goes in the CONTEXT — context fields stick to every
    // later line of the request, including `request completed`. The plaintext
    // email is passed per-call-site instead, so it appears on the auth-flow
    // lines and nowhere else.
    setLogContext({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "login_started", email: input.email },
      "Starting user login",
    );

    try {
      const tokens = await this.auth.login(input.email, input.password);
      // NOTE: `tokens` is deliberately NOT logged — access and refresh tokens
      // are credentials, exactly like the password.
      appLogger.info(
        { app_event: "login_succeeded", email: input.email },
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
          email: input.email,
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
