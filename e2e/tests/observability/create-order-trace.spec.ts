// Distributed-tracing contract — one create_order through the gateway must
// produce ONE trace spanning all three synchronous services.
//
// ## The failure this layer exists to catch
//
// Trace propagation fails silently by construction. Every service still
// answers 200, every log line still gets written, and every service still
// exports spans — they just export them into SEPARATE traces. Nothing is red;
// the cascade is simply not there when someone opens Jaeger to debug an
// incident, which is the one moment it was supposed to exist. Unit tests
// cannot see this: each service's own tests pass with a perfectly formed local
// span, and the break lives entirely in the seam between them.
//
// So the assertion is deliberately end-to-end and gateway-first: a real
// Cognito JWT, the real `POST /v1/orders` route a person hits, and then a read
// of Jaeger's query API to check that users + orders + tracking landed under a
// single traceID.
//
// ## Why gateway, not the direct service URL
//
// The direct-service path fakes the authorizer and skips nginx/njs entirely
// ([[testing]] layer 2 vs layer 3). Header propagation is exactly the kind of
// thing a proxy hop drops, so a trace assertion made against the internal URL
// would pass while the URL users actually hit produced three orphan traces.
//
// ## JE-77 anti-regression — the gRPC server span MUST have a parent
//
// The original bug: grpc-js dispatches the handler on a later tick than the
// metadata callback, so activating the OTel context in `onReceiveMetadata`
// unwound before the handler ever ran. Users' gRPC server span was created,
// exported, and looked perfectly healthy in isolation — as a trace ROOT, with
// no parent, sitting in its own trace next to the caller's. The fix moved
// activation to `onReceiveHalfClose`.
//
// `references.length > 0` is the precise signal, and it is the assertion a
// unit test structurally cannot make: only a real cross-process call can show
// whether the remote parent survived the hop. A regression here silently
// re-splits the trace into two.
//
// ## Scope: the three SYNCHRONOUS services only
//
// events-pipeline is out of scope for the mandatory assertions. It consumes
// SQS asynchronously and joins via span LINKS, not parent-child (spec Decision
// 4), so its spans legitimately belong to a different trace — asserting them
// here would be asserting the wrong relationship. It is also gated on
// DocumentDB, an availability dependency this contract should not inherit.
//
// ## Waiting: several export cycles, never one tight window
//
// Spans reach Jaeger through each service's BatchSpanProcessor (5s default)
// and then the collector's own `batch` processor. This repo has recorded two
// false PASSes from windows pinned to the real export period, so the helper
// POLLS across many multiples of it and, crucially, keeps polling after the
// first match until every expected service is present — `orders` reliably
// arrives a batch ahead of `tracking`, and stopping at the first match would
// report a late service as a missing one.

import { expect, test } from "@playwright/test";

import { getGatewayToken } from "../../support/auth.js";
import { gatewayClient } from "../../support/gateway-client.js";
import {
  describeSpans,
  findTraceByTag,
  isJaegerReachable,
  jaegerBaseURL,
  tagValue,
  type AttributedSpan,
} from "../../support/jaeger-client.js";

/** The three synchronous services one create_order must cross. */
const EXPECTED_SERVICES = ["users", "orders", "tracking"] as const;

/**
 * Generous relative to the ~5s BatchSpanProcessor schedule plus the
 * collector's own batching — margin, not a fitted window.
 */
const TRACE_POLL_TIMEOUT_MS = 90_000;

/**
 * The test's own budget MUST exceed the poll window with room for the order
 * flow, or the poll can never expire first.
 *
 * Verified by mutation, not assumed: with `test.slow()` (3 × the 30s default =
 * exactly 90s) a deliberately-unsatisfiable service expectation died on a bare
 * "Test timeout of 90000ms exceeded" and NONE of the diagnostics below ever
 * printed — the one message this spec exists to produce, lost to a timeout
 * race. An explicit budget is what lets the assertion, rather than the clock,
 * report the failure.
 */
const TEST_TIMEOUT_MS = TRACE_POLL_TIMEOUT_MS + 60_000;

const gatewayURL = process.env.API_GATEWAY_URL ?? "";

/**
 * Matches the Users gRPC SERVER span loosely — by `rpc.system` + `span.kind`,
 * not by an exact operation name.
 *
 * grpc-js instrumentation has named this span `users.v1.Users/GetUserById`,
 * `/users.v1.Users/GetUserById` and `grpc.users.v1.Users/GetUserById` across
 * versions, and the Users call Orders makes could reasonably change method.
 * Pinning the string would make an instrumentation upgrade look like a JE-77
 * regression, which is precisely the confusion this spec exists to prevent.
 */
function isUsersGrpcServerSpan(span: AttributedSpan): boolean {
  return (
    span.serviceName === "users" &&
    tagValue(span, "rpc.system") === "grpc" &&
    tagValue(span, "span.kind") === "server"
  );
}

test.describe("distributed tracing: create_order @observability", () => {
  test.beforeAll(async () => {
    test.skip(
      !(await isJaegerReachable()),
      `Jaeger is not reachable at ${jaegerBaseURL} — run \`make observability-up\``,
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

    // --- Read the trace back out of Jaeger ---
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
      `No Jaeger trace carried order_id=${order.id} after ${found.attempts} polls over ` +
        `${TRACE_POLL_TIMEOUT_MS / 1000}s. The order WAS created (201), so either Orders' ` +
        `create_order workflow span is missing its order_id attribute, or nothing is reaching ` +
        `the collector at all. Check \`make doctor\` and ${jaegerBaseURL}.`,
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
          `View it: ${jaegerBaseURL}/trace/${found.trace!.traceID}`,
    ).toHaveLength(0);

    // The workflow spans themselves, matched loosely by name (they are the two
    // this plan's Tasks 3 and 4 introduce, and they are what make the trace
    // readable as a business flow rather than as raw HTTP).
    const createOrderSpan = spans.find((s) => s.serviceName === "orders" && s.operationName === "create_order");
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
      (s) => s.serviceName === "tracking" && s.operationName === "init_tracking",
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
      `Trace ${found.trace!.traceID} contains no Users gRPC SERVER span (rpc.system=grpc, ` +
        `span.kind=server). Either Users was not called on this flow, or its server span landed ` +
        `in a different trace — which is itself the JE-77 symptom.\n` +
        `Users spans in this trace:\n${describeSpans(spans.filter((s) => s.serviceName === "users"))}`,
    ).not.toHaveLength(0);

    const orphans = usersGrpcServerSpans.filter((span) => span.references.length === 0);
    expect(
      orphans,
      orphans.length === 0
        ? ""
        : `JE-77 REGRESSION: ${orphans.length} of ${usersGrpcServerSpans.length} Users gRPC server ` +
          `span(s) have NO parent (references = []), i.e. they are trace roots.\n` +
          `Orphaned: ${orphans.map((s) => `${s.operationName} (spanID ${s.spanID})`).join(", ")}\n\n` +
          `This is the exact shape of JE-77: the grpc-js interceptor must activate the extracted ` +
          `OTel context in onReceiveHalfClose (which dispatches the handler), NOT in ` +
          `onReceiveMetadata (synchronous — the context unwinds before the handler runs). ` +
          `See services/users/src/shared/observability/grpc-tracing.ts.\n\n` +
          `View it: ${jaegerBaseURL}/trace/${found.trace!.traceID}`,
    ).toHaveLength(0);

    await api.dispose();
  });
});
