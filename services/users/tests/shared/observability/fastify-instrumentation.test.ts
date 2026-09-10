import FastifyOtelInstrumentation from "@fastify/otel";
import { ATTR_HTTP_ROUTE } from "@opentelemetry/semantic-conventions";
import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { testSpanExporter } from "../../setup-tracing.ts";

// CONTRACT: Assert that the route reaches the span, not that @fastify/otel is merely
// INSTALLED — that passes while every server span stays named "POST", because
// instrumentation-http names the span before routing and without `http.route` can only
// use the method. Assert `http.route` rather than the final "POST /v1/..." name: the
// rename needs a real node:http server, which would make this an integration test.
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
