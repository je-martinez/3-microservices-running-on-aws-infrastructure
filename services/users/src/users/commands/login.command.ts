import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { AuthProvider, AuthTokens } from "#shared/auth/auth-provider";
import type { Db } from "#shared/db/prisma";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { AUTH_PROVIDER, DB } from "#shared/tokens";
import { Workflow } from "#shared/observability/workflow-metadata";

export interface LoginInput {
  email: string;
  password: string;
}

export class LoginCommand {
  constructor(public readonly input: LoginInput) {}
}

@Workflow("login")
@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand> {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    @Inject(DB) private readonly db: Db,
  ) {}

  async execute({ input }: LoginCommand): Promise<AuthTokens> {
    // Only email_hash goes in the CONTEXT — context fields stick to every later
    // line of the request. The plaintext email is passed per-call-site instead,
    // so it appears on the auth-flow lines and nowhere else.
    setLogContext({ email_hash: hashEmail(input.email) });
    trace.getActiveSpan()?.setAttributes({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "login_started", email: maskEmail(input.email) },
      "Starting user login",
    );

    // CONTRACT: Do NOT turn this into a 403 — it answers the SAME generic 401
    // invalid_credentials a wrong password gets, or a caller learns both that the
    // account exists and that it is passwordless. Rejecting BEFORE any Cognito
    // call makes the property structural. See [[auth-error-mapping]]
    const existing = await this.db.user.findUnique({ where: { email: input.email } });
    if (existing?.authType === "PASSWORDLESS") {
      appLogger.error(
        { app_event: "login_failed", email: maskEmail(input.email), reason: "passwordless_user" },
        "User login failed: account is passwordless",
      );
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
      return tokens;
    } catch (err) {
      // Distinguished here rather than in the exception filter, which sees only a
      // typed error with no memory of the step that produced it. Wrong credentials
      // and a broken identity provider are different operational problems.
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
      trace.getActiveSpan()?.setAttributes({
        app_event: "login_failed",
        reason: invalid ? "invalid_credentials" : "cognito_error",
      });
      throw err; // rethrown untouched — the HTTP contract is unchanged
    }
  }
}
