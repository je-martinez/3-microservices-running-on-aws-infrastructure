import FastifyOtelInstrumentation from "@fastify/otel";
import { context, trace } from "@opentelemetry/api";
import { RPCType, setRPCMetadata } from "@opentelemetry/core";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { getHttpServerSpan, withHttpServerSpan } from "#shared/observability/request-span";
import { buildLoggerOptions } from "#shared/logging/logger";
import { testSpanExporter } from "../setup.ts";

// CONTRACT: Assert the span id that ENDS UP ON THE LOG RECORD, via the real logger
// options — not `trace.getActiveSpan()` somewhere in the hook. `@fastify/otel` wraps
// every hook in its own span, so without withHttpServerSpan "request completed" is
// stamped with the HOOK's id and is unreachable from the request span in OpenObserve.
// See [[logging-context]]
const instrumentation = new FastifyOtelInstrumentation();

beforeEach(() => {
  testSpanExporter.reset();
});

function appWithCapturedLogs(lines: string[]): FastifyInstance {
  return Fastify({
    disableRequestLogging: true,
    logger: {
      ...buildLoggerOptions({ serviceName: "users", environment: "test" }),
      stream: { write: (s: string) => lines.push(s) },
    } as never,
  });
}

function completedLines(lines: string[]): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.message === "request completed");
}

describe("withHttpServerSpan", () => {
  it("logs from onResponse under the HTTP server span, not the hook span", async () => {
    const lines: string[] = [];
    const app = appWithCapturedLogs(lines);

    // WORKAROUND(test): This onRequest hook stands in for instrumentation-http,
    // which cannot patch node:http under vitest's ESM pipeline. Do NOT register it
    // after the @fastify/otel plugin — hooks run in registration order, and a late
    // one leaves the RPC metadata invisible, so no server span is ever found.
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

    const completed = completedLines(lines);
    // Exactly ONE line: the helper wraps the existing call, it never adds one.
    expect(completed).toHaveLength(1);

    // The hook span is real and DIFFERENT from the server span — otherwise the
    // assertions below would pass for the wrong reason.
    expect(hookSpanId).toBeDefined();
    expect(hookSpanId).not.toBe(serverSpanId);

    expect(completed[0]!.span_id).toBe(serverSpanId);
    expect(completed[0]!.trace_id).toBe(serverSpan.spanContext().traceId);
  });

  it("emits the line unchanged when no HTTP server span is resolvable", async () => {
    // No @fastify/otel plugin, so `request.opentelemetry` is genuinely absent —
    // the shape every unit test in this suite builds the app with.
    const lines: string[] = [];
    const app = appWithCapturedLogs(lines);

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

    const completed = completedLines(lines);
    expect(completed).toHaveLength(1);
    // CONTRACT: OMITTED, never zeroed — a fabricated id joins nothing and reads
    // as a real one. See [[logging-context]]
    expect(completed[0]!.span_id).toBeUndefined();
  });

  it("returns fn's value whether or not a server span resolves", () => {
    const request = {} as FastifyRequest;

    expect(getHttpServerSpan(request)).toBeUndefined();
    expect(withHttpServerSpan(request, () => 42)).toBe(42);
  });
});
