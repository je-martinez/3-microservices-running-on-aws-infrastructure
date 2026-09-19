import type { AuthProvider } from "#shared/auth/auth-provider";
import { appLogger } from "#shared/logging/app-logger";
import { trace } from "@opentelemetry/api";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";

export interface SignOutInput {
  accessToken: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class SignOutCommand {
  private readonly auth: AuthProvider;

  constructor({ auth }: { auth: AuthProvider }) {
    this.auth = auth;
  }

  // WARNING: The access token is a credential and never reaches the span or a log
  // line — not raw, not truncated, not hashed (a hash of a bearer credential is still
  // a handle to it). This flow therefore carries no identifying attribute of its own;
  // the caller's identity reaches the trace via the log context and the parent HTTP
  // span. See [[logging-context]]
  async execute(input: SignOutInput): Promise<void> {
    return withWorkflowSpan("sign_out", { app_event: "sign_out_started" }, () =>
      this.doExecute(input),
    );
  }

  private async doExecute(input: SignOutInput): Promise<void> {
    appLogger.info({ app_event: "sign_out_started" }, "Starting sign-out");

    try {
      await this.auth.signOut(input.accessToken);
    } catch (err) {
      appLogger.error(
        { err, app_event: "sign_out_failed", reason: "cognito_error" },
        "Sign-out failed: Cognito did not revoke the session",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "sign_out_failed", reason: "cognito_error" });
      throw err; // rethrown untouched — the route maps it through the error handler
    }

    appLogger.info({ app_event: "sign_out_succeeded" }, "Session revoked");
    trace.getActiveSpan()?.setAttribute("app_event", "sign_out_succeeded");
  }
}
