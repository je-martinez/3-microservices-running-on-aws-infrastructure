// CONTRACT: One gateway create_order → one trace (users, orders, tracking).
// Assert JE-77 parent on Users gRPC SERVER span. Poll until all services export.
// See [[ADR-0019-distributed-tracing-opentelemetry]]

import { expect, test } from "@playwright/test";

import { getGatewayToken } from "../../support/auth.js";
import { gatewayClient } from "../../support/gateway-client.js";
import {
  describeSpans,
  findTraceByTag,
  isTraceBackendReachable,
  SpanKind,
  tagValue,
  tracesBaseURL,
  viewTraceURL,
  type AttributedSpan,
} from "../../support/traces-client.js";

/** The three synchronous services one create_order must cross. */
const EXPECTED_SERVICES = ["users", "orders", "tracking"] as const;

/**
 * Generous relative to the ~5s BatchSpanProcessor schedule plus the
 * collector's own batching — margin, not a fitted window.
 */
const TRACE_POLL_TIMEOUT_MS = 90_000;

// CONTRACT: Must exceed TRACE_POLL_TIMEOUT_MS or test.slow() aborts before poll diagnostics.
const TEST_TIMEOUT_MS = TRACE_POLL_TIMEOUT_MS + 60_000;

const gatewayURL = process.env.API_GATEWAY_URL ?? "";

/** Match Users gRPC SERVER by rpc_system + span_kind — not operation name (JE-77). */
function isUsersGrpcServerSpan(span: AttributedSpan): boolean {
  return (
    span.serviceName === "users" &&
    tagValue(span, "rpc_system") === "grpc" &&
    span.span_kind === SpanKind.SERVER
  );
}

test.describe("distributed tracing: create_order @observability", () => {
  test.beforeAll(async () => {
    test.skip(
      !(await isTraceBackendReachable()),
      `OpenObserve is not reachable at ${tracesBaseURL} — run \`make observability-up\``,
    );
    test.skip(!gatewayURL, "API_GATEWAY_URL is not set — run `make bootstrap && make env-file`");
  });

  test("one trace carries spans from users, orders and tracking, and the Users gRPC server span has a parent", async () => {
    test.setTimeout(TEST_TIMEOUT_MS);

    // --- Drive the real flow through the gateway with a real Cognito JWT ---
    const { token } = await getGatewayToken();
    const api = await gatewayClient(token);

    const products = await api.get("v1/products");
    expect(products.status(), "GET v1/products through the gateway").toBe(200);
    const catalog = (await products.json()) as Array<{ id: string; unitsInStock: number }>;
    const product = catalog.find((p) => p.unitsInStock > 0);
    expect(product, "no seeded product has stock — run `make post-infra`").toBeTruthy();

    const created = await api.post("v1/orders", {
      data: { lines: [{ productId: product!.id, quantity: 1 }] },
    });
    expect(created.status(), `POST v1/orders: ${await created.text()}`).toBe(201);
    const order = (await created.json()) as { id: string };
    expect(order.id).toBeTruthy();

    // --- Read the trace back out of OpenObserve ---
    //
    // Matched on the `order_id` TAG rather than on a span name: it is a value
    // this very request produced, so it cannot match another run's trace, and
    // it survives a span rename. `create_order` (Orders' workflow span) is what
    // carries it.
    const found = await findTraceByTag("orders", "order_id", order.id, {
      timeoutMs: TRACE_POLL_TIMEOUT_MS,
      // Keep polling until all three services are in — see the header note on
      // partial traces. Without this the spec fails on export skew, not on a
      // real break.
      isComplete: (spans) =>
        EXPECTED_SERVICES.every((service) => spans.some((span) => span.serviceName === service)),
    });

    expect(
      found.trace,
      `No trace carried order_id=${order.id} after ${found.attempts} polls over ` +
        `${TRACE_POLL_TIMEOUT_MS / 1000}s. The order WAS created (201), so either Orders' ` +
        `create_order workflow span is missing its order_id attribute, or nothing is reaching ` +
        `the collector at all. Check \`make doctor\` and ${tracesBaseURL}.`,
    ).toBeTruthy();

    const spans = found.spans;
    const servicesSeen = [...new Set(spans.map((s) => s.serviceName))].sort();
    const missing = EXPECTED_SERVICES.filter((service) => !servicesSeen.includes(service));

    // Report WHAT arrived, not "3 of 4". A count cannot distinguish a broken
    // cascade from a wrong expectation, and the entire cost of this bug class
    // is in identifying WHICH hop dropped the context.
    expect(
      missing,
      missing.length === 0
        ? ""
        : `Trace ${found.trace!.traceID} (order_id=${order.id}) is missing span(s) from: ` +
          `${missing.join(", ")}.\n` +
          `A service absent here did NOT fail the request — the order returned 201 — it exported ` +
          `its spans into a SEPARATE trace, which means the trace context was dropped on the hop ` +
          `into it (check the traceparent header / SQS MessageAttribute on that boundary).\n\n` +
          `Spans that DID arrive under this traceID:\n${describeSpans(spans)}\n\n` +
          `View it: ${viewTraceURL(found.trace!.traceID)}`,
    ).toHaveLength(0);

    // The workflow spans themselves, matched loosely by name (they are the two
    // this plan's Tasks 3 and 4 introduce, and they are what make the trace
    // readable as a business flow rather than as raw HTTP).
    const createOrderSpan = spans.find((s) => s.serviceName === "orders" && s.operation_name === "create_order");
    expect(
      createOrderSpan,
      `Trace ${found.trace!.traceID} has orders spans but no 'create_order' workflow span.\n` +
        `Arrived:\n${describeSpans(spans)}`,
    ).toBeDefined();
    expect(
      tagValue(createOrderSpan!, "app_event"),
      "create_order span should carry the same app_event its flow log does",
    ).toBe("create_order_succeeded");

    const initTrackingSpan = spans.find(
      (s) => s.serviceName === "tracking" && s.operation_name === "init_tracking",
    );
    expect(
      initTrackingSpan,
      `Trace ${found.trace!.traceID} has tracking spans but no 'init_tracking' workflow span.\n` +
        `Arrived:\n${describeSpans(spans)}`,
    ).toBeDefined();
    expect(tagValue(initTrackingSpan!, "order_id")).toBe(order.id);

    // --- JE-77 anti-regression ---
    const usersGrpcServerSpans = spans.filter(isUsersGrpcServerSpan);
    expect(
      usersGrpcServerSpans,
      `Trace ${found.trace!.traceID} contains no Users gRPC SERVER span (rpc_system=grpc, ` +
        `span_kind=${SpanKind.SERVER}/SERVER). Either Users was not called on this flow, or its ` +
        `server span landed ` +
        `in a different trace — which is itself the JE-77 symptom.\n` +
        `Users spans in this trace:\n${describeSpans(spans.filter((s) => s.serviceName === "users"))}`,
    ).not.toHaveLength(0);

    const orphans = usersGrpcServerSpans.filter((span) => span.reference_parent_span_id === undefined);
    expect(
      orphans,
      orphans.length === 0
        ? ""
        : `JE-77 REGRESSION: ${orphans.length} of ${usersGrpcServerSpans.length} Users gRPC server ` +
          `span(s) have NO parent (reference_parent_span_id absent), i.e. they are trace roots.\n` +
          `Orphaned: ${orphans.map((s) => `${s.operation_name} (span_id ${s.span_id})`).join(", ")}\n\n` +
          `This is the exact shape of JE-77: the grpc-js interceptor must activate the extracted ` +
          `OTel context in onReceiveHalfClose (which dispatches the handler), NOT in ` +
          `onReceiveMetadata (synchronous — the context unwinds before the handler runs). ` +
          `See services/users/src/shared/observability/grpc-tracing.ts.\n\n` +
          `View it: ${viewTraceURL(found.trace!.traceID)}`,
    ).toHaveLength(0);

    await api.dispose();
  });
});
