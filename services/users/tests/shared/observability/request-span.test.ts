import FastifyOtelInstrumentation from "@fastify/otel";
import { context, trace } from "@opentelemetry/api";
import { RPCType, setRPCMetadata } from "@opentelemetry/core";
import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { withHttpServerSpan } from "#shared/observability/request-span";
import { buildLoggerOptions } from "#shared/logging/logger";
import { testSpanExporter } from "../../setup-tracing.ts";

// CONTRACT: Assert the span id that ENDS UP ON THE LOG RECORD, via the real logger
// options — not `trace.getActiveSpan()` somewhere in the hook. `@fastify/otel` wraps
// every hook in its own span, so "request completed" is stamped with the HOOK's id and
// becomes unreachable from the request span in OpenObserve.
// See [[logging-context]]
const instrumentation = new FastifyOtelInstrumentation();

beforeEach(() => {
  testSpanExporter.reset();
});

describe("request-span", () => {
  it("logs from onResponse under the HTTP server span, not the hook span", async () => {
    const lines: string[] = [];
    const app = Fastify({
      disableRequestLogging: true,
      logger: {
        ...buildLoggerOptions({ serviceName: "users", environment: "test" }),
        stream: { write: (s: string) => lines.push(s) },
      } as never,
    });
    // CONTRACT: Register this stand-in BEFORE the plugin. It replaces
    // instrumentation-http, which cannot patch node:http under vitest's ESM pipeline,
    // and publishes its SERVER span as RPC metadata exactly as the real one does.
    // Fastify runs onRequest hooks in registration order, so registered after, the
    // metadata is invisible to @fastify/otel and no server span is found — a property
    // of this stand-in, not of the real stack.
    const serverSpan = trace.getTracer("test").startSpan("POST /v1/users/register");
    const serverSpanId = serverSpan.spanContext().spanId;
    app.addHook("onRequest", (_req, _reply, done) => {
      context.with(
        setRPCMetadata(trace.setSpan(context.active(), serverSpan), {
          type: RPCType.HTTP,
          span: serverSpan,
        }),
        done,
      );
    });

    await app.register(instrumentation.plugin());

    let hookSpanId: string | undefined;
    app.addHook("onResponse", (req, reply, done) => {
      // What the active span WOULD be without the fix — the hook's own span.
      hookSpanId = trace.getActiveSpan()?.spanContext().spanId;
      withHttpServerSpan(req, () => {
        req.log.info(
          { http_route: req.routeOptions?.url, http_response_status_code: reply.statusCode },
          "request completed",
        );
      });
      done();
    });

    app.post("/v1/users/register", async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: "POST", url: "/v1/users/register", payload: {} });
    expect(response.statusCode).toBe(200);
    await app.close();
    serverSpan.end();

    const completed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.message === "request completed");

    // Still exactly ONE line — the fix wraps the existing call, it does not add
    // a second one (see the `disableRequestLogging` comment in http/routes.ts,
    // where a duplicate doubled every request-rate figure).
    expect(completed).toHaveLength(1);

    // The hook span is real and DIFFERENT from the server span — otherwise the
    // assertion below would pass for the wrong reason.
    expect(hookSpanId).toBeDefined();
    expect(hookSpanId).not.toBe(serverSpanId);

    // THE POINT: the log carries the server span's id, the one a user clicks.
    expect(completed[0]!.span_id).toBe(serverSpanId);
    expect(completed[0]!.span_id).not.toBe(hookSpanId);
    expect(completed[0]!.trace_id).toBe(serverSpan.spanContext().traceId);
  });

  it("emits the line unchanged when no HTTP server span is resolvable", async () => {
    // The unit suite builds the app with no SDK and no @fastify/otel plugin, so
    // `request.opentelemetry` is genuinely absent. The line must still be
    // emitted (just without a span id) rather than throwing or being skipped —
    // a fabricated or zeroed id would be worse than none (see logger.ts).
    const lines: string[] = [];
    const app = Fastify({
      disableRequestLogging: true,
      logger: {
        ...buildLoggerOptions({ serviceName: "users", environment: "test" }),
        stream: { write: (s: string) => lines.push(s) },
      } as never,
    });

    app.addHook("onResponse", (req, _reply, done) => {
      withHttpServerSpan(req, () => {
        req.log.info({ http_route: req.routeOptions?.url }, "request completed");
      });
      done();
    });

    app.post("/v1/users/register", async () => ({ ok: true }));
    await app.ready();
    await app.inject({ method: "POST", url: "/v1/users/register", payload: {} });
    await app.close();

    const completed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.message === "request completed");

    expect(completed).toHaveLength(1);
    // OMITTED, never zeroed — the rule logger.ts already applies.
    expect(completed[0]!.span_id).toBeUndefined();
  });
});
