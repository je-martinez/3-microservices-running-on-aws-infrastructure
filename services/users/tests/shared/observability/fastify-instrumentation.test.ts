import FastifyOtelInstrumentation from "@fastify/otel";
import { ATTR_HTTP_ROUTE } from "@opentelemetry/semantic-conventions";
import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { testSpanExporter } from "../../setup-tracing.ts";

// Proves the route actually reaches the span, rather than asserting that
// @fastify/otel is merely INSTALLED — which would pass even while every server
// span stayed named "POST". That was the real bug: the span is created by
// instrumentation-http BEFORE routing, so with no `http.route` it can only name
// itself after the method, and the endpoint is invisible in Jaeger.
//
// The assertion is on `http.route` rather than on the final "POST /v1/..." span
// name on purpose. The rename is performed by instrumentation-http, which only
// patches a real node:http server; driving one here would make this an
// integration test. What Fastify contributes — the piece that was missing — is
// the route attribute, and instrumentation-http's rename follows from it.
//
// A negative control while writing this: without the plugin registered, the
// request span carries no `http.route` at all.
const instrumentation = new FastifyOtelInstrumentation();

beforeEach(() => {
  testSpanExporter.reset();
});

describe("Fastify instrumentation", () => {
  it("records http.route with the route pattern, not the resolved URL", async () => {
    const app = Fastify();
    await app.register(instrumentation.plugin());
    app.get("/v1/users/:id", () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/v1/users/usr_123" });
    expect(response.statusCode).toBe(200);

    const routed = testSpanExporter
      .getFinishedSpans()
      .filter((span) => span.attributes[ATTR_HTTP_ROUTE] !== undefined);

    expect(routed.length).toBeGreaterThan(0);
    // The PATTERN, so all ids aggregate into one endpoint — a span carrying
    // "/v1/users/usr_123" would make every request its own distinct operation.
    expect(routed[0]!.attributes[ATTR_HTTP_ROUTE]).toBe("/v1/users/:id");

    await app.close();
  });
});
