// Covers ONE thing: that the CUSTOM_AUTH challenge carries the caller's trace
// context down to the Cognito trigger.
//
// Why this needs a test at all: the OTP email is published by the Cognito
// trigger Lambda, NOT by this service, so none of the SQS-publisher tests reach
// it. Cognito invokes that trigger itself, which means the trigger has no
// ambient trace context and no OTel SDK to read one with — ClientMetadata is
// the only caller-controlled channel Cognito forwards to it. Without the
// injection asserted here, the OTP email's pipeline work lands in a trace of
// its own, detached from the request that asked for the code (observed live).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { CognitoAuthProvider } from "#shared/auth/cognito-auth-provider.ts";

const provider = new NodeTracerProvider();

beforeAll(() => {
  // A real SDK, not a stub: `propagation.inject` on the UNREGISTERED default is
  // a no-op that writes nothing, so a stubbed setup would make this test pass
  // while proving nothing about the production path.
  // `register()` installs the context manager AND the tracer provider, which is
  // what makes `context.with` propagate and `propagation.inject` write anything.
  provider.register({ propagator: new W3CTraceContextPropagator() });
});

afterAll(async () => {
  await provider.shutdown();
});

function providerWith(send: ReturnType<typeof vi.fn>) {
  return new CognitoAuthProvider({ send } as never, "us-east-1_pool", "client-id");
}

describe("CognitoAuthProvider.startOtpChallenge — trace propagation", () => {
  it("passes the active span's traceparent to the trigger via ClientMetadata", async () => {
    const send = vi.fn(async () => ({ Session: "sess_1" }));
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("otp_challenge");

    await context.with(trace.setSpan(context.active(), span), () =>
      providerWith(send).startOtpChallenge("ada@example.com"),
    );
    span.end();

    const { ClientMetadata } = send.mock.calls[0][0].input;
    expect(ClientMetadata.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    // The id on the wire must be THIS span's, not some other trace's — a
    // well-formed traceparent naming the wrong span still parses downstream and
    // would attach the email to an unrelated request.
    expect(ClientMetadata.traceparent).toContain(span.spanContext().traceId);
  });

  it("omits ClientMetadata entirely when no span is active", async () => {
    const send = vi.fn(async () => ({ Session: "sess_1" }));

    await providerWith(send).startOtpChallenge("ada@example.com");

    // Not an empty object and not a blank traceparent: the trigger shape-checks
    // the value, and sending a key with nothing usable in it only invites a
    // consumer to parent onto a trace that does not exist.
    expect(send.mock.calls[0][0].input.ClientMetadata).toBeUndefined();
  });
});
