import { describe, expect, it, vi } from "vitest";
import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { CognitoAuthProvider } from "#shared/auth/cognito-auth-provider";
import { NoMatchingUserError } from "#features/users/webhooks/capture-cognito-identity";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";
import { testSpanExporter } from "../../setup.ts";

const EMAIL = "john.doe@gmail.com";

// A thrown message reaches OpenObserve verbatim: the workflow span records it as
// the exception event and as the status message. See [[logging-context]]
function expectNoEmail(message: string) {
  expect(message).not.toContain(EMAIL);
  expect(message).not.toContain("john.doe");
  expect(message).not.toContain(maskEmail(EMAIL));
}

function providerAnswering(response: unknown) {
  const send = vi.fn().mockResolvedValue(response);
  const client = { send } as unknown as CognitoIdentityProviderClient;
  return new CognitoAuthProvider(client, "pool", "client");
}

async function thrownBy(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a throw");
}

describe("thrown messages never carry the email", () => {
  it("signUp: a create response with no sub", async () => {
    const provider = providerAnswering({ User: { Attributes: [] } });
    const err = await thrownBy(() => provider.signUp(EMAIL, "Passw0rd!", "usr_1", "John Doe"));
    expectNoEmail(err.message);
    expect(err.message).toBe("Cognito AdminCreateUser returned no sub");
  });

  it("startOtpChallenge: an InitiateAuth response with no session", async () => {
    const provider = providerAnswering({});
    const err = await thrownBy(() => provider.startOtpChallenge(EMAIL));
    expectNoEmail(err.message);
    expect(err.message).toBe("CUSTOM_AUTH InitiateAuth returned no session");
  });

  it("NoMatchingUserError identifies the user by email_hash, also on the exported span", async () => {
    const err = new NoMatchingUserError(EMAIL);
    expectNoEmail(err.message);
    expect(err.message).toContain(hashEmail(EMAIL));

    testSpanExporter.reset();
    await thrownBy(() =>
      withWorkflowSpan("cognito_webhook", {}, async () => {
        throw err;
      }),
    );
    const [span] = testSpanExporter.getFinishedSpans();
    expectNoEmail(JSON.stringify({ status: span.status, events: span.events }));
  });
});
