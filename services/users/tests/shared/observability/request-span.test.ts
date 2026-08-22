import FastifyOtelInstrumentation from "@fastify/otel";
import { context, trace } from "@opentelemetry/api";
import { RPCType, setRPCMetadata } from "@opentelemetry/core";
import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { withHttpServerSpan } from "#shared/observability/request-span";
import { buildLoggerOptions } from "#shared/logging/logger";
import { testSpanExporter } from "../../setup-tracing.ts";

// THE REGRESSION THIS PINS DOWN. `@fastify/otel` wraps every Fastify hook in a
// span of its own, so a log emitted from the `onResponse` hook is stamped with
// the HOOK's span id — and "request completed", the one line carrying
// http_route/status/duration, stopped being reachable from the request span in
// OpenObserve ("View logs" filters on span_id + trace_id and matched nothing).
//
// The assertion is on the span id that ENDS UP ON THE LOG RECORD, produced by
// the real logger options, rather than on `trace.getActiveSpan()` at some point
// in the hook. That is the thing that was broken and the thing the user reads.
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
    // Stands in for @opentelemetry/instrumentation-http, which cannot patch
    // node:http under vitest's ESM pipeline. It publishes its SERVER span the
    // same way the real one does — as RPC metadata on the active context — and
    // that is the exact channel the fix reads. Without it @fastify/otel would
    // make its own `request` span a SERVER root and there would be no upstream
    // span to distinguish, so the test could not tell the bug from the fix.
    //
    // Registered BEFORE the plugin ON PURPOSE: Fastify runs onRequest hooks in
    // registration order, and @fastify/otel reads the RPC metadata off the
    // active context when it creates its `request` span. Registered after, this
    // hook runs too late, the metadata is invisible to the plugin, and the fix
    // finds no server span — which is a property of this stand-in, not of the
    // real stack, where instrumentation-http patches node:http and is always
    // upstream of every Fastify hook.
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
