import { describe, it, expect, vi, beforeEach } from "vitest";
import { context, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { SqsEventPublisher } from "#shared/messaging/event-publisher";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { logContext } from "#shared/logging/log-context";
import { NanoIdConfig } from "#shared/id/nano-id";
import { testSpanExporter } from "../../setup-tracing.ts";

const QUEUE_URL = "http://localhost:4566/000000000000/events";

// A hand-rolled double instead of vi.mock("@aws-sdk/client-sqs"): the real
// SendMessageCommand must stay real so the assertions below inspect the command
// the publisher actually built, not a stub of our own making.
function fakeClient(send = vi.fn(async () => ({ MessageId: "m1" }))) {
  return { send } as unknown as SQSClient & { send: ReturnType<typeof vi.fn> };
}

function sentCommand(client: ReturnType<typeof fakeClient>): SendMessageCommand {
  return client.send.mock.calls[0]![0] as SendMessageCommand;
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

describe("SqsEventPublisher", () => {
  // The SQS hop is the one place the trace cascade can break invisibly: there is
  // no auto-instrumentation carrying context across a queue, so if these
  // attributes are wrong the pipeline simply starts a fresh, disconnected trace
  // and nothing anywhere reports an error.
  //
  // The tracer provider is registered in tests/setup-tracing.ts, which also
  // installs the default W3C CompositePropagator that `propagation.inject`
  // resolves — a real propagator, not a stub, so the string asserted below is
  // the exact one that would go on the wire.
  //
  // IMPORTANT, and MEASURED rather than assumed: what these tests observe is
  // what `traceparentAttributes()` writes, because the client here is a fake and
  // no AWS SDK instrumentation is in the loop. IN PRODUCTION IT IS NOT THE FINAL
  // VALUE. @opentelemetry/instrumentation-aws-sdk's `requestPostSpanHook` runs
  // after its own `<queue> send` span is started, inside that span's context,
  // and calls `propagation.inject` on the SAME MessageAttributes object — so it
  // OVERWRITES whatever is there, unconditionally. Verified against the real
  // instrumentation with a stub SQS endpoint: a deliberately bogus traceparent
  // set by the caller came out replaced by the SDK span's id.
  //
  // That does NOT make this seam pointless, and it is not a bug to fix here:
  // the SDK's span is a CHILD of the publish span (measured:
  // register -> sqs.publish user_created -> events send), so the consumer joins
  // one level below the publish rather than beside it either way. The subtree is
  // right; only the exact span id differs. What this seam guarantees, and what
  // these tests pin, is that a well-formed traceparent naming a span INSIDE the
  // publish is produced even when nothing else injects one.
  //
  // Since the publisher now always opens its own span, the old "no active span"
  // case is gone: a traceparent is always present at this seam.
  describe("traceparent propagation", () => {
    const tracer = trace.getTracer("test");

    // 00-<32 hex trace id>-<16 hex span id>-<2 hex flags>
    const W3C_TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

    beforeEach(() => {
      testSpanExporter.reset();
    });

    function publishedSpan() {
      return testSpanExporter.getFinishedSpans().find((s) => s.name.startsWith("sqs.publish"))!;
    }

    async function publishInsideSpan(publish: (publisher: SqsEventPublisher) => Promise<void>) {
      const client = fakeClient();
      const span = tracer.startSpan("test-span");

      await context.with(trace.setSpan(context.active(), span), () =>
        publish(new SqsEventPublisher(client, QUEUE_URL)),
      );
      span.end();

      return { client, span };
    }

    it("injects a W3C traceparent message attribute when publishUserCreated runs inside an active span", async () => {
      const { client, span } = await publishInsideSpan((publisher) => publisher.publishUserCreated(PAYLOAD));

      const traceparent = sentCommand(client).input.MessageAttributes!.traceparent;
      expect(traceparent).toBeDefined();
      expect(traceparent!.DataType).toBe("String");
      expect(traceparent!.StringValue).toMatch(W3C_TRACEPARENT);
      // The caller's TRACE, but the PUBLISH span — the pipeline must join this
      // trace, and hang under the send rather than beside it.
      expect(traceparent!.StringValue).toBe(
        `00-${span.spanContext().traceId}-${publishedSpan().spanContext().spanId}-01`,
      );
    });

    it("injects the traceparent on the password-reset publish too, not only on USER_CREATED", async () => {
      const { client, span } = await publishInsideSpan((publisher) =>
        publisher.publishPasswordResetRequested(RESET_PAYLOAD),
      );

      const traceparent = sentCommand(client).input.MessageAttributes!.traceparent;
      expect(traceparent!.StringValue).toBe(
        `00-${span.spanContext().traceId}-${publishedSpan().spanContext().spanId}-01`,
      );
    });

    it("keeps type and source alongside it — the trace context is added, never a replacement", async () => {
      const { client } = await publishInsideSpan((publisher) => publisher.publishUserCreated(PAYLOAD));

      const attributes = sentCommand(client).input.MessageAttributes!;
      expect(attributes.type).toEqual({ DataType: "String", StringValue: "USER_CREATED" });
      expect(attributes.source).toEqual({ DataType: "String", StringValue: "users" });
    });

    it("still injects one with no caller span — the publish span is a root, and a real one", async () => {
      const client = fakeClient();

      // No context.with. This used to omit the key, because the only candidate
      // was the caller's span and there was none. Now the publisher opens its
      // own, so the message carries a valid traceparent naming a root publish
      // span — which is strictly better: the pipeline's work joins THAT trace
      // instead of starting an orphan of its own.
      await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

      const traceparent = sentCommand(client).input.MessageAttributes!.traceparent;
      const span = publishedSpan();
      expect(traceparent!.StringValue).toBe(
        `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
      );
      // Never a zeroed or empty id: those PARSE downstream, so the consumer
      // would parent its span to a trace that never existed and the cascade
      // would break in silence — worse than an absent key.
      expect(traceparent!.StringValue).toMatch(W3C_TRACEPARENT);
      expect(span.spanContext().traceId).not.toMatch(/^0+$/);
      expect(span.parentSpanContext).toBeUndefined();
    });

    it("does the same on the password-reset publish outside a caller span", async () => {
      const client = fakeClient();

      await new SqsEventPublisher(client, QUEUE_URL).publishPasswordResetRequested(RESET_PAYLOAD);

      const span = publishedSpan();
      expect(sentCommand(client).input.MessageAttributes!.traceparent!.StringValue).toBe(
        `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
      );
    });

    it("never puts the trace context in the envelope body — that is a Zod-validated domain contract", async () => {
      const { client } = await publishInsideSpan((publisher) => publisher.publishUserCreated(PAYLOAD));

      const raw = sentCommand(client).input.MessageBody!;
      // Scanned on the RAW string, not the parsed object: the rule is that the
      // pipeline's EnvelopeSchema never sees these keys at any depth.
      expect(raw).not.toContain("traceparent");
      expect(raw).not.toContain("tracestate");
    });
  });

  // The correlation id has to travel ON THE ENVELOPE, not just in this service's
  // own log lines: the events-pipeline runs no OTel SDK, so this field is the
  // only thing tying the email it sends back to the request that caused it.
  //
  // This was a real gap — Users seeded request_id for HTTP but did not forward
  // it, so an E2E run produced 309 pipeline lines with no correlation id, all of
  // them from Users-published events (USER_CREATED, PASSWORD_RESET_REQUESTED,
  // AUTH_OTP_REQUESTED) while Orders' and Tracking's carried one.
  describe("request_id propagation", () => {
    it("puts the active request's id on the envelope", async () => {
      const client = fakeClient();
      const request_id = NanoIdConfig.newRequestId();

      await logContext.run({ request_id }, () =>
        new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD),
      );

      const body = JSON.parse(sentCommand(client).input.MessageBody!);
      expect(body.request_id).toBe(request_id);
    });

    it("OMITS the key entirely outside a request", async () => {
      // Never null: the pipeline's schema is `.optional().min(1)`, so an
      // explicit null or "" is a PermanentError there — the message is dropped
      // without retry and its email is lost.
      const client = fakeClient();

      await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

      const body = JSON.parse(sentCommand(client).input.MessageBody!);
      expect("request_id" in body).toBe(false);
    });
  });

  it("sends exactly one SendMessageCommand to the configured queue URL", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    expect(client.send).toHaveBeenCalledOnce();
    const command = sentCommand(client);
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command.input.QueueUrl).toBe(QUEUE_URL);
  });

  it("sets type and source as SQS message attributes so the queue is inspectable without deserializing", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const attributes = sentCommand(client).input.MessageAttributes!;
    expect(attributes.type).toEqual({ DataType: "String", StringValue: "USER_CREATED" });
    expect(attributes.source).toEqual({ DataType: "String", StringValue: "users" });
  });

  it("builds the snake_case envelope the pipeline validates, with order_id present and null", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    expect(body.type).toBe("USER_CREATED");
    expect(body.source).toBe("users");
    expect(body.user_id).toBe("usr_1");
    // The pipeline's EnvelopeSchema declares order_id nullable, NOT optional —
    // a missing key is rejected, so the key must be present and null.
    expect(Object.keys(body)).toContain("order_id");
    expect(body.order_id).toBeNull();
  });

  it("carries everything the welcome email renders: email, fullName, userId and createdAt", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    // The WHOLE payload, so both a missing field (blank row in the email) and a
    // stray extra one (an unannounced wire change) fail here.
    expect(body.payload).toEqual({
      email: "a@example.com",
      fullName: "Ada Lovelace",
      userId: "usr_1",
      createdAt: "2026-01-15T10:30:00.000Z",
    });
  });

  it("keeps the payload camelCase — the casing of the field it joins, not the envelope's", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    // This payload has always been camelCase (`fullName`), while the envelope
    // around it is snake_case. New fields follow the payload so it stays
    // internally consistent; the snake_case forms must NOT appear.
    expect(Object.keys(body.payload).sort()).toEqual(["createdAt", "email", "fullName", "userId"]);
    expect(body.payload).not.toHaveProperty("user_id");
    expect(body.payload).not.toHaveProperty("created_at");
  });

  it("serializes createdAt as an ISO-8601 string, not a raw Date or an epoch number", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    expect(typeof body.payload.createdAt).toBe("string");
    expect(body.payload.createdAt).toBe(CREATED_AT.toISOString());
  });

  it("puts the same usr_ id in the payload as on the envelope, so 'Account ID' matches the subject", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    // The renderer reads the payload, never the envelope — but the two must
    // still agree, or the email prints an id for a different account.
    expect(body.payload.userId).toBe(body.user_id);
    expect(body.payload.userId).toMatch(/^usr_/);
  });

  it("stamps the author block naming WHO originated the event, not just who it is about", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    // The whole object, so a stray extra key fails here rather than reaching
    // the consumer. `actor` is the same semantic AuditActor value the audit
    // columns carry for this write path.
    expect(body.author).toEqual({
      actor: "users_api:register",
      user_id: "usr_1",
      cognito_sub: "a1b2-c3d4",
    });
  });

  it("does not duplicate the producing service inside author — the root source owns it", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    // AuthorSchema has no `source`. Two copies of a per-publisher constant
    // carry no information and can only drift; the root one stays.
    expect(body.author).not.toHaveProperty("source");
    expect(body.source).toBe("users");
  });

  it("OMITS cognito_sub from the serialized author when the caller supplied none", async () => {
    const client = fakeClient();
    const { cognitoSub: _omitted, ...withoutSub } = PAYLOAD;
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(withoutSub);

    // Read back off the SERIALIZED body, not the object: the rule is about the
    // JSON on the wire. `"cognito_sub": null` would satisfy a `?.toBeFalsy()`
    // assertion and violate the contract, so the key's ABSENCE is what is
    // pinned.
    const raw = sentCommand(client).input.MessageBody!;
    const body = JSON.parse(raw);
    expect(Object.keys(body.author)).toEqual(["actor", "user_id"]);
    expect(raw).not.toContain("cognito_sub");
  });

  it("keeps the author's user_id as the real id, never the actor label", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    // The subject and the author coincide on a self-registration; the point is
    // that `author.user_id` is an id, not the `users_api:register` label — a
    // consumer joining on it must get a joinable value.
    expect(body.author.user_id).toBe(body.user_id);
    expect(body.author.user_id).not.toContain(":");
  });

  it("names the payload's id field `userId`, not the seam's bare `id`", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    // The id DOES travel now (the email prints it), but under an unambiguous
    // name: a bare `id` inside a payload would read as the event's own id.
    expect(body.payload).not.toHaveProperty("id");
    expect(body.payload.userId).toBe("usr_1");
  });

  it("generates the event_id itself, prefixed evt_, so the caller's signature stays unchanged", async () => {
    const client = fakeClient();
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

    const body = JSON.parse(sentCommand(client).input.MessageBody!);
    expect(body.event_id).toMatch(/^evt_.+/);
  });

  it("generates a distinct event_id per publish (it is the pipeline's idempotency key)", async () => {
    const client = fakeClient();
    const publisher = new SqsEventPublisher(client, QUEUE_URL);
    await publisher.publishUserCreated(PAYLOAD);
    await publisher.publishUserCreated(PAYLOAD);

    const first = JSON.parse((client.send.mock.calls[0]![0] as SendMessageCommand).input.MessageBody!);
    const second = JSON.parse((client.send.mock.calls[1]![0] as SendMessageCommand).input.MessageBody!);
    expect(first.event_id).not.toBe(second.event_id);
  });

  it("swallows a send failure so a queue outage cannot fail an otherwise successful registration", async () => {
    const client = fakeClient(
      vi.fn(async () => {
        throw new Error("queue unreachable");
      }),
    );

    await expect(new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD)).resolves.toBeUndefined();
  });

  it("reports the swallowed failure as an alertable *_failed error log", async () => {
    const { fields, message } = await captureFailureLog();

    expect(fields.app_event).toBe("user_created_publish_failed");
    expect(fields.user_id).toBe("usr_1");
    expect(message).toBeTruthy();
  });

  it("never puts the plaintext email in the failure log line — only its hash", async () => {
    const { fields, message } = await captureFailureLog();

    // Serialize everything the log call carries (the `err` included) and scan
    // it: the address must not appear anywhere in the emitted line.
    const emitted = JSON.stringify(fields) + message;
    expect(emitted).not.toContain("a@example.com");
    expect(fields.email).toBeUndefined();
    expect(fields.email_hash).toBe(hashEmail("a@example.com"));
  });
  // The PRODUCER span this publisher creates for itself. The AWS SDK's
  // auto-instrumentation already emits `<queue> send`, but every event in the
  // system goes to the SAME queue, so that name distinguishes nothing — it says
  // where, never what. These spans are named after the EVENT TYPE, matching
  // Orders' `sqs.publish order_created`.
  describe("publish span", () => {
    const tracer = trace.getTracer("test");

    beforeEach(() => {
      testSpanExporter.reset();
    });

    function publishSpans() {
      return testSpanExporter
        .getFinishedSpans()
        .filter((s) => s.name.startsWith("sqs.publish"));
    }

    it("names the USER_CREATED publish after the event type, as a PRODUCER", async () => {
      const client = fakeClient();
      await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);

      const spans = publishSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe("sqs.publish user_created");
      expect(spans[0]!.kind).toBe(SpanKind.PRODUCER);
      expect(spans[0]!.attributes.event_type).toBe("user_created");
      expect(spans[0]!.attributes["messaging.system"]).toBe("aws_sqs");
      expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
    });

    it("names the password-reset publish after ITS event type, not a shared generic one", async () => {
      const client = fakeClient();
      await new SqsEventPublisher(client, QUEUE_URL).publishPasswordResetRequested(RESET_PAYLOAD);

      const spans = publishSpans();
      expect(spans).toHaveLength(1);
      // The whole point of owning this span: two different events on one queue
      // must read as two different nodes.
      expect(spans[0]!.name).toBe("sqs.publish password_reset_requested");
      expect(spans[0]!.kind).toBe(SpanKind.PRODUCER);
    });

    it("hangs under the caller's span rather than starting a new trace", async () => {
      const client = fakeClient();
      const parent = tracer.startSpan("register");

      await context.with(trace.setSpan(context.active(), parent), () =>
        new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD),
      );
      parent.end();

      const span = publishSpans()[0]!;
      expect(span.spanContext().traceId).toBe(parent.spanContext().traceId);
      expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    });

    // THE regression this span exists to keep honest, and the exact bug fixed
    // on the Orders side (commit 81c52a7): there the message attributes were
    // built before the publish span existed, so the traceparent carried the
    // enclosing workflow span and the consumer's work hung BESIDE the publish
    // instead of under it. Nothing errors when that happens — the waterfall is
    // just quietly wrong.
    //
    // What is pinned is that the injected id belongs INSIDE the publish, never
    // to the workflow above it. With the real AWS SDK instrumentation loaded the
    // final wire value is its `<queue> send` span instead (it overwrites this —
    // see the block comment above), and that span is a CHILD of the publish, so
    // the property asserted here still holds end to end.
    it("injects the traceparent of the PUBLISH span, not of the enclosing workflow span", async () => {
      const client = fakeClient();
      const workflow = tracer.startSpan("register");

      await context.with(trace.setSpan(context.active(), workflow), () =>
        new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD),
      );
      workflow.end();

      const publish = publishSpans()[0]!;
      const traceparent = sentCommand(client).input.MessageAttributes!.traceparent!.StringValue;

      expect(traceparent).toBe(
        `00-${publish.spanContext().traceId}-${publish.spanContext().spanId}-01`,
      );
      // Stated as its own assertion so a future refactor that reverts to
      // building the attributes early fails HERE, naming the cause, instead of
      // only failing the equality above.
      expect(traceparent).not.toContain(workflow.spanContext().spanId);
    });

    it("injects the publish span's id on the password-reset send too", async () => {
      const client = fakeClient();
      const workflow = tracer.startSpan("password_reset_requested");

      await context.with(trace.setSpan(context.active(), workflow), () =>
        new SqsEventPublisher(client, QUEUE_URL).publishPasswordResetRequested(RESET_PAYLOAD),
      );
      workflow.end();

      const publish = publishSpans()[0]!;
      const traceparent = sentCommand(client).input.MessageAttributes!.traceparent!.StringValue;
      expect(traceparent).toBe(
        `00-${publish.spanContext().traceId}-${publish.spanContext().spanId}-01`,
      );
      expect(traceparent).not.toContain(workflow.spanContext().spanId);
    });

    it("comes out ERROR when the send fails, even though the publisher swallows it", async () => {
      const client = fakeClient(
        vi.fn(async () => {
          throw new Error("queue unreachable");
        }),
      );
      const spy = vi.spyOn(appLogger, "error").mockImplementation((() => {}) as never);
      try {
        await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);
      } finally {
        spy.mockRestore();
      }

      const span = publishSpans()[0]!;
      // A failed send must not render as a healthy hop. The publisher returns
      // normally by design, so the span is the ONLY place this stays visible.
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe("queue unreachable");
      expect(span.events.some((e) => e.name === "exception")).toBe(true);
      expect(span.ended).toBe(true);
    });
  });

  // JE-179: a span with no log line of its own answers "View logs" with
  // nothing. OpenObserve filters that button on trace_id AND span_id with no
  // fallback to the trace, so the line has to be emitted while the publish span
  // is the ACTIVE one — not merely somewhere in the same trace.
  describe("publish log line", () => {
    beforeEach(() => {
      testSpanExporter.reset();
    });

    it("emits the success line INSIDE the publish span, so its span_id matches", async () => {
      const client = fakeClient();
      const { fields, activeSpanId } = await captureInfoLog(() =>
        new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD),
      );

      const publish = testSpanExporter
        .getFinishedSpans()
        .find((s) => s.name === "sqs.publish user_created")!;
      // Read at the log CALL SITE, which is what the Pino formatter reads to
      // stamp span_id on the emitted line (shared/logging/logger.ts). Asserting
      // the field on a captured line would only prove the formatter ran.
      expect(activeSpanId).toBe(publish.spanContext().spanId);
      expect(fields.app_event).toBe("user_created_published");
      expect(fields.event_id).toMatch(/^evt_/);
      expect(fields.user_id).toBe("usr_1");
    });

    it("emits one for the password-reset publish as well", async () => {
      const client = fakeClient();
      const { fields, activeSpanId } = await captureInfoLog(() =>
        new SqsEventPublisher(client, QUEUE_URL).publishPasswordResetRequested(RESET_PAYLOAD),
      );

      const publish = testSpanExporter
        .getFinishedSpans()
        .find((s) => s.name === "sqs.publish password_reset_requested")!;
      expect(activeSpanId).toBe(publish.spanContext().spanId);
      expect(fields.app_event).toBe("password_reset_requested_published");
      expect(fields.user_id).toBe("usr_1");
    });

    it("carries no PII: the hash identifies the recipient, never the address", async () => {
      const client = fakeClient();
      const { fields, message } = await captureInfoLog(() =>
        new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD),
      );

      const emitted = JSON.stringify(fields) + message;
      expect(emitted).not.toContain("a@example.com");
      expect(emitted).not.toContain("Ada Lovelace");
      expect(fields.email_hash).toBe(hashEmail("a@example.com"));
    });

    it("never logs the reset code — it is the live credential the event exists to deliver", async () => {
      const client = fakeClient();
      const { fields, message } = await captureInfoLog(() =>
        new SqsEventPublisher(client, QUEUE_URL).publishPasswordResetRequested(RESET_PAYLOAD),
      );

      expect(JSON.stringify(fields) + message).not.toContain("123456");
    });

    it("emits the FAILURE line inside the publish span too, so a red span's logs answer", async () => {
      const client = fakeClient(
        vi.fn(async () => {
          throw new Error("queue unreachable");
        }),
      );
      let activeSpanId: string | undefined;
      const spy = vi.spyOn(appLogger, "error").mockImplementation((() => {
        activeSpanId = trace.getActiveSpan()?.spanContext().spanId;
      }) as never);

      try {
        await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);
      } finally {
        spy.mockRestore();
      }

      const publish = testSpanExporter
        .getFinishedSpans()
        .find((s) => s.name === "sqs.publish user_created")!;
      // An operator looking at a red publish span goes straight to its logs.
      // If the catch sat outside the span scope that lookup would come back
      // empty — the Orders fix in the same commit.
      expect(activeSpanId).toBe(publish.spanContext().spanId);
    });
  });});

// Drives a real publish against a failing client and returns what the publisher
// actually handed the logger. The logger is spied on rather than injected —
// `appLogger` is a module singleton by design (no logger is threaded through
// constructors in this service).
async function captureFailureLog(): Promise<{ fields: Record<string, any>; message: string }> {
  const client = fakeClient(
    vi.fn(async () => {
      throw new Error("queue unreachable");
    }),
  );
  const calls: Array<[Record<string, any>, string]> = [];
  const spy = vi.spyOn(appLogger, "error").mockImplementation(((fields: any, message: any) => {
    calls.push([fields, message]);
  }) as never);

  try {
    await new SqsEventPublisher(client, QUEUE_URL).publishUserCreated(PAYLOAD);
  } finally {
    // mockRestore() clears the spy's own call history in vitest 2, so the calls
    // are captured into `calls` above rather than read back off the spy.
    spy.mockRestore();
  }

  expect(calls).toHaveLength(1);
  const [fields, message] = calls[0]!;
  return { fields, message };
}

// Captures what the publisher handed `appLogger.info`, plus the span that was
// ACTIVE at the moment of the call — the thing that decides which span's "View
// logs" will return this line.
async function captureInfoLog(publish: () => Promise<void>): Promise<{
  fields: Record<string, any>;
  message: string;
  activeSpanId: string | undefined;
}> {
  const calls: Array<[Record<string, any>, string, string | undefined]> = [];
  const spy = vi.spyOn(appLogger, "info").mockImplementation(((fields: any, message: any) => {
    calls.push([fields, message, trace.getActiveSpan()?.spanContext().spanId]);
  }) as never);

  try {
    await publish();
  } finally {
    spy.mockRestore();
  }

  expect(calls).toHaveLength(1);
  const [fields, message, activeSpanId] = calls[0]!;
  return { fields, message, activeSpanId };
}
