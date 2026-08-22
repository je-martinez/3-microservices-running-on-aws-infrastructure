import type { AuthProvider, RefreshedTokens } from "#shared/auth/auth-provider";
import { trace } from "@opentelemetry/api";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";

export interface RefreshInput {
  refreshToken: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class RefreshTokenCommand {
  private readonly auth: AuthProvider;

  constructor({ auth }: { auth: AuthProvider }) {
    this.auth = auth;
  }

  // This flow has NO identifying attribute to carry, and that is deliberate.
  // Its only input is the refresh token, which is a credential exactly like the
  // password in login.ts: it never appears on the span — not raw, not
  // truncated, not hashed (a hash of a bearer credential is still a stable
  // handle to it, and it identifies nothing an operator can act on). The
  // returned tokens get the same treatment. The caller's identity reaches the
  // trace anyway, through the log context and the parent HTTP span.
  async execute(input: RefreshInput): Promise<RefreshedTokens> {
    return withWorkflowSpan("refresh_token", { app_event: "refresh_token_started" }, () =>
      this.doExecute(input),
    );
  }

  private async doExecute(input: RefreshInput): Promise<RefreshedTokens> {
    // No flow log here: this endpoint had none before, and the task is to add
    // the business span, not to grow the log stream. The span carries the
    // outcome instead.
    try {
      const tokens = await this.auth.refresh(input.refreshToken);
      trace.getActiveSpan()?.setAttribute("app_event", "refresh_token_succeeded");
      return tokens;
    } catch (err) {
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "refresh_token_failed", reason: "cognito_error" });
      throw err; // rethrown untouched — the HTTP contract is unchanged
    }
  }
}
