import type { AuthProvider, AuthTokens } from "#shared/auth/auth-provider";
import type { Db } from "#shared/db/prisma";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { trace } from "@opentelemetry/api";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";

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

  // Span attributes mirror the flow's own log fields. `email_hash`, never the
  // email itself — and the password and the returned tokens never appear on a
  // span any more than they do on a log line.
  async execute(input: LoginInput): Promise<AuthTokens> {
    return withWorkflowSpan(
      "login",
      { app_event: "login_started", email_hash: hashEmail(input.email) },
      () => this.doExecute(input),
    );
  }

  private async doExecute(input: LoginInput): Promise<AuthTokens> {
    // Only email_hash goes in the CONTEXT — context fields stick to every
    // later line of the request, including `request completed`. The plaintext
    // email is passed per-call-site instead, so it appears on the auth-flow
    // lines and nowhere else.
    setLogContext({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "login_started", email: maskEmail(input.email) },
      "Starting user login",
    );

    // CONTRACT: Do NOT turn this into a 403 — it answers the SAME generic 401
    // invalid_credentials a wrong password gets, or a caller learns both that the
    // account exists and that it is passwordless. The real cause goes only to the log
    // as `reason: passwordless_user`. Rejecting BEFORE any Cognito call makes the
    // property structural: Cognito still holds a random never-revealed password for
    // these users. See [[auth-error-mapping]]
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
      // Same reason as the log line, same branch. The real cause stays
      // operator-only here too: the HTTP response is still the generic 401.
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "login_failed", reason: "passwordless_user" });
      throw new InvalidCredentialsError();
    }

    try {
      const tokens = await this.auth.login(input.email, input.password);
      // WARNING: Never log `tokens` — access and refresh tokens are credentials,
      // exactly like the password.
      appLogger.info(
        { app_event: "login_succeeded", email: maskEmail(input.email) },
        "User login completed",
      );
      trace.getActiveSpan()?.setAttribute("app_event", "login_succeeded");
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
      trace
        .getActiveSpan()
        ?.setAttributes({
          app_event: "login_failed",
          reason: invalid ? "invalid_credentials" : "cognito_error",
        });
      throw err; // rethrown untouched — the HTTP contract is unchanged
    }
  }
}
