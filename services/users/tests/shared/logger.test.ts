import { describe, it, expect } from "vitest";
import pino from "pino";
import { context, trace } from "@opentelemetry/api";
import { buildLoggerOptions, SEVERITY_NUMBER } from "#shared/logging/logger";
import { runWithLogContext, setLogContext } from "#shared/logging/log-context";

function capture(): { lines: string[]; stream: { write: (s: string) => void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => lines.push(s) } };
}

describe("buildLoggerOptions", () => {
  it("emits the snake_case OTel-aligned schema", () => {
    const { lines, stream } = capture();
    const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
    log.info({ trace_id: "req-1" }, "request completed");
    const rec = JSON.parse(lines[0]);
    expect(rec.severity_text).toBe("INFO");
    expect(rec.severity_number).toBe(SEVERITY_NUMBER.INFO);
    expect(rec.service_name).toBe("users");
    expect(rec.deployment_environment).toBe("local");
    expect(rec.message).toBe("request completed");
    expect(rec.trace_id).toBe("req-1");
    expect(rec.timestamp).toBeDefined();
    expect(rec.level).toBeUndefined();
    expect(rec.msg).toBeUndefined();
  });

  it("maps error severity number", () => {
    const { lines, stream } = capture();
    const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
    log.error({ error_type: "ValidationError" }, "boom");
    const rec = JSON.parse(lines[0]);
    expect(rec.severity_text).toBe("ERROR");
    expect(rec.severity_number).toBe(17);
  });

  it("promotes err to top-level error_type/error_message, matching the shared schema", () => {
    class NoMatchingUserError extends Error {}
    const { lines, stream } = capture();
    const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
    log.error({ err: new NoMatchingUserError("boom") }, "failed");
    const rec = JSON.parse(lines[0]);
    expect(rec.error_type).toBe("NoMatchingUserError");
    expect(rec.error_message).toBe("boom");
  });

  it("does not add error_type/error_message to a normal log with no err", () => {
    const { lines, stream } = capture();
    const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
    log.info({ trace_id: "req-1" }, "request completed");
    const rec = JSON.parse(lines[0]);
    expect(rec.error_type).toBeUndefined();
    expect(rec.error_message).toBeUndefined();
  });

  describe("request log context", () => {
    it("merges the active context into every line", async () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      await runWithLogContext({ cognito_sub: "sub-1", user_id: "usr_1" }, async () => {
        log.info("in context");
      });

      const rec = JSON.parse(lines[0]);
      expect(rec.cognito_sub).toBe("sub-1");
      expect(rec.user_id).toBe("usr_1");
      expect(rec.message).toBe("in context");
    });

    it("omits unknown context fields rather than emitting null", async () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      await runWithLogContext({ cognito_sub: "sub-1" }, async () => {
        log.info("partial");
      });

      const rec = JSON.parse(lines[0]);
      expect(rec.cognito_sub).toBe("sub-1");
      expect("user_id" in rec).toBe(false);
      expect("email" in rec).toBe(false);
      expect("email_hash" in rec).toBe(false);
    });

    it("picks up fields added mid-request", async () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      await runWithLogContext({ cognito_sub: "sub-1" }, async () => {
        setLogContext({ user_id: "usr_late" });
        log.info("after enrichment");
      });

      expect(JSON.parse(lines[0]).user_id).toBe("usr_late");
    });

    it("emits no context fields outside a request", () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      log.info("outside");

      const rec = JSON.parse(lines[0]);
      expect("cognito_sub" in rec).toBe(false);
      expect(rec.service_name).toBe("users");
    });

    it("lets an explicit call-site field win over the context", async () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      await runWithLogContext({ order_id: "ord_ctx" }, async () => {
        log.info({ order_id: "ord_explicit" }, "override");
      });

      expect(JSON.parse(lines[0]).order_id).toBe("ord_explicit");
    });

    it("still promotes err while carrying the context", async () => {
      class CognitoError extends Error {}
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      await runWithLogContext({ cognito_sub: "sub-1" }, async () => {
        log.error({ err: new CognitoError("boom") }, "failed");
      });

      const rec = JSON.parse(lines[0]);
      expect(rec.cognito_sub).toBe("sub-1");
      expect(rec.error_type).toBe("CognitoError");
      expect(rec.error_message).toBe("boom");
    });
  });

  // The logs<->traces join is string equality between OpenObserve and Jaeger, so
  // these assert the SHAPE of the ids as much as their presence — a truncated or
  // uppercased id matches nothing and reports no error. The real tracer provider
  // registered by tests/setup-tracing.ts is what makes these spans valid; a fake
  // span object would prove nothing about `spanContext()`'s actual output.
  describe("trace correlation", () => {
    it("stamps the active span's trace_id and span_id on the line", () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
      const span = trace.getTracer("test").startSpan("unit");

      context.with(trace.setSpan(context.active(), span), () => {
        log.info({ app_event: "register_succeeded" }, "registered");
      });
      span.end();

      const rec = JSON.parse(lines[0]);
      const spanContext = span.spanContext();
      expect(rec.trace_id).toBe(spanContext.traceId);
      expect(rec.span_id).toBe(spanContext.spanId);
      // Lowercase, zero-padded hex: 32 chars for the trace, 16 for the span.
      expect(rec.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(rec.span_id).toMatch(/^[0-9a-f]{16}$/);
      // The flow logs are the whole point of this: they are what had never
      // carried an id.
      expect(rec.app_event).toBe("register_succeeded");
    });

    it("OMITS both ids outside a span — never empty, never all-zero", () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      log.info({ app_event: "metrics_tick" }, "no span here");

      const rec = JSON.parse(lines[0]);
      // `in` rather than a truthiness check: `trace_id: ""` or an all-zero id
      // would pass the latter and is exactly the failure mode being excluded —
      // a zeroed id reads as real and would silently join unrelated lines.
      expect("trace_id" in rec).toBe(false);
      expect("span_id" in rec).toBe(false);
    });

    it("carries the ids alongside the request context, without touching request_id", async () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
      const span = trace.getTracer("test").startSpan("unit");

      await runWithLogContext({ request_id: "req_abc", user_id: "usr_1" }, async () => {
        await context.with(trace.setSpan(context.active(), span), async () => {
          log.info("in both");
        });
      });
      span.end();

      const rec = JSON.parse(lines[0]);
      // request_id is a DIFFERENT field with a different job (it spans the
      // Lambdas, which run no SDK) — the span ids must not displace it.
      expect(rec.request_id).toBe("req_abc");
      expect(rec.user_id).toBe("usr_1");
      expect(rec.trace_id).toBe(span.spanContext().traceId);
    });

    it("lets an explicit call-site trace_id win, as the `request completed` hook relies on", () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
      const span = trace.getTracer("test").startSpan("unit");

      context.with(trace.setSpan(context.active(), span), () => {
        log.info({ trace_id: "explicit" }, "override");
      });
      span.end();

      expect(JSON.parse(lines[0]).trace_id).toBe("explicit");
    });
  });
});
