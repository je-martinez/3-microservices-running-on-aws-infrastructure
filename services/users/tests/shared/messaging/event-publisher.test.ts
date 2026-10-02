import { beforeEach, describe, expect, it, vi } from "vitest";
import { context, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import { NoopEventPublisher, SnsEventPublisher } from "#shared/messaging/event-publisher";
import { hashEmail } from "#shared/logging/email-hash";
import { logContext } from "#shared/logging/log-context";
import { NanoIdConfig } from "#shared/id/nano-id";
import { testSpanExporter } from "../../setup.ts";
import { captureAppLogs, lineFor } from "../../helpers/capture-app-logs.ts";

const TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:3mrai-local-events-topic";
// 00-<32 hex trace id>-<16 hex span id>-<2 hex flags>
const W3C_TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

// A hand-rolled double instead of vi.mock("@aws-sdk/client-sns"): PublishCommand
// stays real, so assertions inspect the command the publisher actually built.
function fakeClient(send = vi.fn(async (_command: PublishCommand) => ({ MessageId: "m1" }))) {
  return { send } as unknown as SNSClient & { send: typeof send };
}

function failingClient() {
  return fakeClient(
    vi.fn(async (_command: PublishCommand) => {
      throw new Error("topic unreachable");
    }),
  );
}

function sentCommand(client: ReturnType<typeof fakeClient>, index = 0): PublishCommand {
  return client.send.mock.calls[index]![0];
}

function sentBody(client: ReturnType<typeof fakeClient>, index = 0) {
  return JSON.parse(sentCommand(client, index).input.Message!);
}

function publishSpan(name: string) {
  const spans = testSpanExporter.getFinishedSpans().filter((s) => s.name === name);
  expect(spans).toHaveLength(1);
  return spans[0]!;
}

function traceparentOf(span: ReturnType<typeof publishSpan>): string {
  return `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`;
}

const CREATED_AT = new Date("2026-01-15T10:30:00.000Z");

const PAYLOAD = {
  id: "usr_1",
  email: "a@example.com",
  fullName: "Ada Lovelace",
  createdAt: CREATED_AT,
  cognitoSub: "a1b2-c3d4",
};

const RESET_PAYLOAD = {
  userId: "usr_1",
  email: "a@example.com",
  fullName: "Ada Lovelace",
  code: "123456",
  ttlSeconds: 600,
  cognitoSub: "a1b2-c3d4",
};

const tracer = trace.getTracer("test");

beforeEach(() => {
  testSpanExporter.reset();
});

describe("SnsEventPublisher.publishUserCreated", () => {
  it("sends exactly one PublishCommand to the configured topic ARN", async () => {
    const client = fakeClient();
    await new SnsEventPublisher(client, TOPIC_ARN).publishUserCreated(PAYLOAD);

    expect(client.send).toHaveBeenCalledOnce();
    const command = sentCommand(client);
    expect(command).toBeInstanceOf(PublishCommand);
    expect(command.input.TopicArn).toBe(TOPIC_ARN);
  });

  it("builds the snake_case envelope the pipeline validates, with order_id present and null", async () => {
    const client = fakeClient();
    await new SnsEventPublisher(client, TOPIC_ARN).publishUserCreated(PAYLOAD);

    const body = sentBody(client);
    expect(body.type).toBe("USER_CREATED");
    expect(body.source).toBe("users");
    expect(body.user_id).toBe("usr_1");
    // CONTRACT: EnvelopeSchema declares order_id nullable, NOT optional — a
    // missing key is rejected by the pipeline.
    expect(Object.keys(body)).toContain("order_id");
    expect(body.order_id).toBeNull();
  });

  it("carries exactly what the welcome email renders, camelCase, createdAt as ISO-8601", async () => {
    const client = fakeClient();
    await new SnsEventPublisher(client, TOPIC_ARN).publishUserCreated(PAYLOAD);

    // The WHOLE payload, so a missing field (blank email row) and a stray extra
    // one (an unannounced wire change, or a bare `id` read as the event's own
    // id) both fail here.
    expect(sentBody(client).payload).toEqual({
      email: "a@example.com",
      fullName: "Ada Lovelace",
      userId: "usr_1",
      createdAt: "2026-01-15T10:30:00.000Z",
    });
  });

  it("stamps the author block with the real id, the register actor, and no duplicated source", async () => {
    const client = fakeClient();
    await new SnsEventPublisher(client, TOPIC_ARN).publishUserCreated(PAYLOAD);

    const body = sentBody(client);
    expect(body.author).toEqual({
      actor: "users_api:register",
      user_id: "usr_1",
      cognito_sub: "a1b2-c3d4",
    });
    expect(body.author.user_id).toBe(body.user_id);
  });

  it("OMITS cognito_sub from the serialized author when the caller supplied none", async () => {
    const client = fakeClient();
    const { cognitoSub: _omitted, ...withoutSub } = PAYLOAD;
    await new SnsEventPublisher(client, TOPIC_ARN).publishUserCreated(withoutSub);

    // Scanned on the RAW wire string: `"cognito_sub": null` would satisfy a
    // falsy check and still violate the contract.
    const raw = sentCommand(client).input.Message!;
    expect(Object.keys(JSON.parse(raw).author)).toEqual(["actor", "user_id"]);
    expect(raw).not.toContain("cognito_sub");
  });

  it("mints a distinct evt_ id per publish — the pipeline's idempotency key", async () => {
    const client = fakeClient();
    const publisher = new SnsEventPublisher(client, TOPIC_ARN);
    await publisher.publishUserCreated(PAYLOAD);
    await publisher.publishUserCreated(PAYLOAD);

    expect(sentBody(client, 0).event_id).toMatch(/^evt_.+/);
    expect(sentBody(client, 0).event_id).not.toBe(sentBody(client, 1).event_id);
  });

  it("sets type and source as message attributes so a queue is inspectable without deserializing", async () => {
    const client = fakeClient();
    await new SnsEventPublisher(client, TOPIC_ARN).publishUserCreated(PAYLOAD);

    const attributes = sentCommand(client).input.MessageAttributes!;
    expect(attributes.type).toEqual({ DataType: "String", StringValue: "USER_CREATED" });
    expect(attributes.source).toEqual({ DataType: "String", StringValue: "users" });
  });

  it("swallows a publish failure and reports it as an alertable error line with no plaintext email", async () => {
    const client = failingClient();

    // CONTRACT: Swallowed — the user row and Cognito account already exist, so a
    // throw reports an error for a registration that succeeded. captureAppLogs
    // rethrows, so a rethrowing publisher fails this test here.
    const lines = await captureAppLogs(() =>
      new SnsEventPublisher(client, TOPIC_ARN).publishUserCreated(PAYLOAD),
    );

    const failed = lineFor(lines, "user_created_publish_failed");
    expect(failed).toBeDefined();
    expect(failed!.severity_text).toBe("ERROR");
    expect(failed!.reason).toBe("sns_publish_failed");
    expect(failed!.user_id).toBe("usr_1");
    expect(failed!.email_hash).toBe(hashEmail("a@example.com"));
    expect(JSON.stringify(lines)).not.toContain("a@example.com");
  });
});

describe("SnsEventPublisher.publishPasswordResetRequested", () => {
  it("builds the envelope with the reset actor and exactly the four payload keys the consumer expects", async () => {
    const client = fakeClient();
    await new SnsEventPublisher(client, TOPIC_ARN).publishPasswordResetRequested(RESET_PAYLOAD);

    const body = sentBody(client);
    expect(body.type).toBe("PASSWORD_RESET_REQUESTED");
    expect(body.source).toBe("users");
    expect(body.user_id).toBe("usr_1");
    expect(body.order_id).toBeNull();
    expect(body.event_id).toMatch(/^evt_/);
    expect(body.author).toEqual({
      actor: "users_api:password_reset_requested",
      user_id: "usr_1",
      cognito_sub: "a1b2-c3d4",
    });
    // CONTRACT: Exactly these keys, mixed casing included. The pipeline redacts
    // only these, so any extra key next to a live credential is persisted verbatim.
    expect(body.payload).toEqual({
      email: "a@example.com",
      full_name: "Ada Lovelace",
      code: "123456",
      ttlSeconds: 600,
    });
  });

  it("keeps the code out of the message attributes", async () => {
    const client = fakeClient();
    await new SnsEventPublisher(client, TOPIC_ARN).publishPasswordResetRequested(RESET_PAYLOAD);

    const attributes = sentCommand(client).input.MessageAttributes!;
    expect(attributes.type).toEqual({ DataType: "String", StringValue: "PASSWORD_RESET_REQUESTED" });
    expect(JSON.stringify(attributes)).not.toContain("123456");
  });

  it("swallows a publish failure and logs it without the code or the plaintext email", async () => {
    const client = failingClient();

    const lines = await captureAppLogs(() =>
      new SnsEventPublisher(client, TOPIC_ARN).publishPasswordResetRequested(RESET_PAYLOAD),
    );

    const failed = lineFor(lines, "password_reset_requested_publish_failed");
    expect(failed).toBeDefined();
    expect(failed!.severity_text).toBe("ERROR");
    expect(failed!.reason).toBe("sns_publish_failed");
    expect(failed!.email_hash).toBe(hashEmail("a@example.com"));
    const emitted = JSON.stringify(lines);
    expect(emitted).not.toContain("123456");
    expect(emitted).not.toContain("a@example.com");
  });
});

// CONTRACT: request_id and run_id travel ON THE ENVELOPE — the events-pipeline
// runs no OTel SDK, so they are the only correlation it gets. Each is OMITTED
// when unknown: the pipeline declares both `.optional().min(1)`, so null or ""
// is a PermanentError and the message's email is lost. See [[logging-context]]
describe("correlation ids on the envelope", () => {
  it("puts the active request's id on the envelope", async () => {
    const client = fakeClient();
    const request_id = NanoIdConfig.newRequestId();

    await logContext.run({ request_id }, () =>
      new SnsEventPublisher(client, TOPIC_ARN).publishUserCreated(PAYLOAD),
    );

    expect(sentBody(client).request_id).toBe(request_id);
  });

  it("puts the active run's id on both event types", async () => {
    const client = fakeClient();
    const publisher = new SnsEventPublisher(client, TOPIC_ARN);

    await logContext.run({ run_id: "run_abc" }, async () => {
      await publisher.publishUserCreated(PAYLOAD);
      await publisher.publishPasswordResetRequested(RESET_PAYLOAD);
    });

    expect(sentBody(client, 0).run_id).toBe("run_abc");
    expect(sentBody(client, 1).run_id).toBe("run_abc");
  });

  it("OMITS both keys outside a request, on both event types", async () => {
    const client = fakeClient();
    const publisher = new SnsEventPublisher(client, TOPIC_ARN);
    await publisher.publishUserCreated(PAYLOAD);
    await publisher.publishPasswordResetRequested(RESET_PAYLOAD);

    for (const index of [0, 1]) {
      const body = sentBody(client, index);
      expect("request_id" in body).toBe(false);
      expect("run_id" in body).toBe(false);
    }
  });
});

describe("publish span", () => {
  it("names each publish after its event type, as a PRODUCER on aws_sns", async () => {
    const client = fakeClient();
    const publisher = new SnsEventPublisher(client, TOPIC_ARN);
    await publisher.publishUserCreated(PAYLOAD);
    await publisher.publishPasswordResetRequested(RESET_PAYLOAD);

    const created = publishSpan("sns.publish user_created");
    expect(created.kind).toBe(SpanKind.PRODUCER);
    expect(created.attributes.event_type).toBe("user_created");
    expect(created.attributes["messaging.system"]).toBe("aws_sns");
    expect(created.status.code).toBe(SpanStatusCode.OK);

    const reset = publishSpan("sns.publish password_reset_requested");
    expect(reset.kind).toBe(SpanKind.PRODUCER);
    expect(reset.attributes.event_type).toBe("password_reset_requested");
  });

  it("hangs under the caller's span rather than starting a new trace", async () => {
    const client = fakeClient();
    const parent = tracer.startSpan("register");

    await context.with(trace.setSpan(context.active(), parent), () =>
      new SnsEventPublisher(client, TOPIC_ARN).publishUserCreated(PAYLOAD),
    );
    parent.end();

    const span = publishSpan("sns.publish user_created");
    expect(span.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it("comes out ERROR when the send fails, even though the publisher swallows it", async () => {
    await captureAppLogs(() =>
      new SnsEventPublisher(failingClient(), TOPIC_ARN).publishUserCreated(PAYLOAD),
    );

    // The span is the ONLY place the failed send stays visible in the trace.
    const span = publishSpan("sns.publish user_created");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("topic unreachable");
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
    expect(span.ended).toBe(true);
  });
});

// CONTRACT: The traceparent rides in MessageAttributes and names the PUBLISH span.
// Built before the span exists, it names the enclosing workflow span and the
// pipeline's work hangs BESIDE the publish — valid, so nothing errors.
// See [[logging-context]]
describe("traceparent propagation", () => {
  it("injects the publish span's traceparent under a workflow span, on both event types", async () => {
    for (const [publish, spanName] of [
      [(p: SnsEventPublisher) => p.publishUserCreated(PAYLOAD), "sns.publish user_created"],
      [(p: SnsEventPublisher) => p.publishPasswordResetRequested(RESET_PAYLOAD), "sns.publish password_reset_requested"],
    ] as const) {
      testSpanExporter.reset();
      const client = fakeClient();
      const workflow = tracer.startSpan("workflow");

      await context.with(trace.setSpan(context.active(), workflow), () =>
        publish(new SnsEventPublisher(client, TOPIC_ARN)),
      );
      workflow.end();

      const traceparent = sentCommand(client).input.MessageAttributes!.traceparent!;
      expect(traceparent.DataType).toBe("String");
      expect(traceparent.StringValue).toBe(traceparentOf(publishSpan(spanName)));
      expect(traceparent.StringValue).toContain(workflow.spanContext().traceId);
      expect(traceparent.StringValue).not.toContain(workflow.spanContext().spanId);
    }
  });

  it("still injects a real one with no caller span — the publish span is the root", async () => {
    const client = fakeClient();
    await new SnsEventPublisher(client, TOPIC_ARN).publishUserCreated(PAYLOAD);

    const span = publishSpan("sns.publish user_created");
    const traceparent = sentCommand(client).input.MessageAttributes!.traceparent!.StringValue;
    // A zeroed or empty id still PARSES downstream and parents onto a trace that
    // never existed, so the shape and the non-zero trace id are both pinned.
    expect(traceparent).toMatch(W3C_TRACEPARENT);
    expect(traceparent).toBe(traceparentOf(span));
    expect(span.spanContext().traceId).not.toMatch(/^0+$/);
    expect(span.parentSpanContext).toBeUndefined();
  });

  it("never puts the trace context in the envelope body", async () => {
    const client = fakeClient();
    const workflow = tracer.startSpan("workflow");
    await context.with(trace.setSpan(context.active(), workflow), () =>
      new SnsEventPublisher(client, TOPIC_ARN).publishUserCreated(PAYLOAD),
    );
    workflow.end();

    const raw = sentCommand(client).input.Message!;
    expect(raw).not.toContain("traceparent");
    expect(raw).not.toContain("tracestate");
  });
});

// CONTRACT: Each publish logs INSIDE its own span. OpenObserve's "View logs"
// filters on trace_id AND span_id with no fallback, so a line stamped with any
// other span leaves the publish span answering with nothing. See [[logging-context]]
describe("publish log line", () => {
  it("emits the USER_CREATED success line under the publish span, with no PII", async () => {
    const lines = await captureAppLogs(() =>
      new SnsEventPublisher(fakeClient(), TOPIC_ARN).publishUserCreated(PAYLOAD),
    );

    const span = publishSpan("sns.publish user_created");
    const line = lineFor(lines, "user_created_published");
    expect(line).toBeDefined();
    expect(line!.span_id).toBe(span.spanContext().spanId);
    expect(line!.trace_id).toBe(span.spanContext().traceId);
    expect(line!.event_id).toMatch(/^evt_/);
    expect(line!.user_id).toBe("usr_1");
    expect(line!.email_hash).toBe(hashEmail("a@example.com"));
    const emitted = JSON.stringify(lines);
    expect(emitted).not.toContain("a@example.com");
    expect(emitted).not.toContain("Ada Lovelace");
  });

  it("emits the PASSWORD_RESET_REQUESTED success line under its span, never logging the code", async () => {
    const lines = await captureAppLogs(() =>
      new SnsEventPublisher(fakeClient(), TOPIC_ARN).publishPasswordResetRequested(RESET_PAYLOAD),
    );

    const span = publishSpan("sns.publish password_reset_requested");
    const line = lineFor(lines, "password_reset_requested_published");
    expect(line).toBeDefined();
    expect(line!.span_id).toBe(span.spanContext().spanId);
    expect(line!.user_id).toBe("usr_1");
    expect(JSON.stringify(lines)).not.toContain("123456");
  });

  it("emits the FAILURE line under the publish span too, so a red span's logs answer", async () => {
    const lines = await captureAppLogs(() =>
      new SnsEventPublisher(failingClient(), TOPIC_ARN).publishUserCreated(PAYLOAD),
    );

    const span = publishSpan("sns.publish user_created");
    expect(lineFor(lines, "user_created_publish_failed")!.span_id).toBe(span.spanContext().spanId);
  });
});

describe("NoopEventPublisher", () => {
  it("resolves both publishes without throwing", async () => {
    const publisher = new NoopEventPublisher();
    await expect(publisher.publishUserCreated(PAYLOAD)).resolves.toBeUndefined();
    await expect(publisher.publishPasswordResetRequested(RESET_PAYLOAD)).resolves.toBeUndefined();
  });
});
