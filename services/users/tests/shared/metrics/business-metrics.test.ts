import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { BusinessMetricsPoller } from "#shared/metrics/business-metrics";
import { testSpanExporter } from "../../setup-tracing.ts";
import { captureAppLogs, lineFor } from "../../helpers/capture-app-logs.ts";

function makeDeps(counts: { password: number; passwordless: number }) {
  const publish = vi.fn(async () => {});
  const db = {
    user: {
      count: vi.fn(async ({ where }: any) =>
        where.authType === "PASSWORD" ? counts.password : counts.passwordless,
      ),
    },
  };
  return { publish, db, metricsPublisher: { publish }, env: { METRICS_INTERVAL_MS: 15_000 } };
}

beforeEach(() => {
  testSpanExporter.reset();
});

describe("BusinessMetricsPoller", () => {
  it("publishes one users_total series per HasPassword value", async () => {
    const d = makeDeps({ password: 7, passwordless: 3 });
    const poller = new BusinessMetricsPoller(d as any);

    await poller.collectAndPublish();

    expect(d.publish).toHaveBeenCalledWith("users_total", 7, {
      Service: "users",
      HasPassword: "true",
    });
    expect(d.publish).toHaveBeenCalledWith("users_total", 3, {
      Service: "users",
      HasPassword: "false",
    });
  });

  it("excludes soft-deleted users from both counts", async () => {
    const d = makeDeps({ password: 1, passwordless: 1 });
    const poller = new BusinessMetricsPoller(d as any);

    await poller.collectAndPublish();

    for (const call of d.db.user.count.mock.calls) {
      expect((call[0] as any).where.deletedAt).toBeNull();
    }
  });

  it("never throws when the database query fails", async () => {
    const d = makeDeps({ password: 0, passwordless: 0 });
    d.db.user.count = vi.fn(async () => {
      throw new Error("db down");
    });
    const poller = new BusinessMetricsPoller(d as any);

    await expect(poller.collectAndPublish()).resolves.toBeUndefined();
  });

  // The tick fires from a setInterval, with no request span around it. Without
  // an explicit span the Prisma and CloudWatch spans it produces come out as
  // their own ROOT traces, and Jaeger fills with anonymous
  // `prisma:client:operation` fragments nobody can attribute to a process.
  it("wraps the tick in an INTERNAL span named metrics-tick", async () => {
    const d = makeDeps({ password: 2, passwordless: 1 });
    const poller = new BusinessMetricsPoller(d as any);

    await poller.collectAndPublish();

    const spans = testSpanExporter.getFinishedSpans();
    const tick = spans.find((s) => s.name === "metrics-tick");
    expect(tick).toBeDefined();
    expect(tick!.kind).toBe(SpanKind.INTERNAL);
    expect(tick!.status.code).toBe(SpanStatusCode.OK);
  });

  it("nests the work the tick does INSIDE the span rather than beside it", async () => {
    // The db/metrics doubles are not instrumented, so nothing would be traced
    // on its own. Starting a span from inside `publish` stands in for the real
    // Prisma/CloudWatch spans: if `metrics-tick` used startSpan instead of
    // startActiveSpan, this one would come out a sibling ROOT — exactly the
    // orphan shape being fixed.
    const d = makeDeps({ password: 1, passwordless: 1 });
    d.metricsPublisher.publish = vi.fn(async () => {
      trace.getTracer("test").startSpan("inner-work").end();
    });
    const poller = new BusinessMetricsPoller(d as any);

    await poller.collectAndPublish();

    const spans = testSpanExporter.getFinishedSpans();
    const tick = spans.find((s) => s.name === "metrics-tick");
    const inner = spans.filter((s) => s.name === "inner-work");
    expect(tick).toBeDefined();
    expect(inner.length).toBeGreaterThan(0);
    for (const span of inner) {
      expect(span.parentSpanContext?.spanId).toBe(tick!.spanContext().spanId);
      expect(span.spanContext().traceId).toBe(tick!.spanContext().traceId);
    }
  });

  it("marks the span ERROR when the tick fails, while still swallowing the error", async () => {
    const d = makeDeps({ password: 0, passwordless: 0 });
    d.db.user.count = vi.fn(async () => {
      throw new Error("db down");
    });
    const poller = new BusinessMetricsPoller(d as any);

    await expect(poller.collectAndPublish()).resolves.toBeUndefined();

    const tick = testSpanExporter.getFinishedSpans().find((s) => s.name === "metrics-tick");
    expect(tick).toBeDefined();
    expect(tick!.status.code).toBe(SpanStatusCode.ERROR);
    expect(tick!.status.message).toBe("db down");
    expect(tick!.events.some((e) => e.name === "exception")).toBe(true);
  });
});

describe("BusinessMetricsPoller logging", () => {
  beforeEach(() => testSpanExporter.reset());

  it("logs metrics_tick_succeeded INSIDE the metrics-tick span", async () => {
    // Before this line existed the tick was invisible on the success path: only
    // failures logged, so "did the poller run at all?" had no answer in the log
    // stream, and the span's "View logs" was empty.
    const d = makeDeps({ password: 7, passwordless: 3 });
    const poller = new BusinessMetricsPoller(d as any);

    const lines = await captureAppLogs(() => poller.collectAndPublish());

    const tick = testSpanExporter.getFinishedSpans().find((s) => s.name === "metrics-tick");
    const line = lineFor(lines, "metrics_tick_succeeded");
    expect(line).toBeDefined();
    expect(line!.span_id).toBe(tick!.spanContext().spanId);
    expect(line!.trace_id).toBe(tick!.spanContext().traceId);
  });

  it("states WHAT was published, not merely that the tick ran", async () => {
    const d = makeDeps({ password: 7, passwordless: 3 });
    const poller = new BusinessMetricsPoller(d as any);

    const lines = await captureAppLogs(() => poller.collectAndPublish());

    const line = lineFor(lines, "metrics_tick_succeeded")!;
    expect(line.users_with_password).toBe(7);
    expect(line.users_without_password).toBe(3);
    expect(line.users_total).toBe(10);
  });

  it("carries app_event=metrics_tick_succeeded on the span too, matching the line", async () => {
    const d = makeDeps({ password: 1, passwordless: 1 });
    const poller = new BusinessMetricsPoller(d as any);

    await captureAppLogs(() => poller.collectAndPublish());

    const tick = testSpanExporter.getFinishedSpans().find((s) => s.name === "metrics-tick");
    expect(tick!.attributes.app_event).toBe("metrics_tick_succeeded");
  });

  it("logs no success line when the tick fails, only metrics_collection_failed", async () => {
    const d = makeDeps({ password: 0, passwordless: 0 });
    d.db.user.count = vi.fn(async () => {
      throw new Error("db down");
    });
    const poller = new BusinessMetricsPoller(d as any);

    const lines = await captureAppLogs(() => poller.collectAndPublish());

    expect(lineFor(lines, "metrics_tick_succeeded")).toBeUndefined();
    const failed = lineFor(lines, "metrics_collection_failed");
    expect(failed).toBeDefined();
    expect(failed!.reason).toBe("db down");
  });

  it("keeps the failure line OUTSIDE the span, as the span must see the throw to go ERROR", async () => {
    // Not an oversight being pinned: the catch is deliberately outside the span
    // (business-metrics.ts), which is what lets the span come out ERROR. The
    // cost is that this one line does not share the tick's span_id, and this
    // test records that trade-off so moving the catch inside fails loudly.
    const d = makeDeps({ password: 0, passwordless: 0 });
    d.db.user.count = vi.fn(async () => {
      throw new Error("db down");
    });
    const poller = new BusinessMetricsPoller(d as any);

    const lines = await captureAppLogs(() => poller.collectAndPublish());

    const tick = testSpanExporter.getFinishedSpans().find((s) => s.name === "metrics-tick");
    expect(tick!.status.code).toBe(SpanStatusCode.ERROR);
    expect(lineFor(lines, "metrics_collection_failed")!.span_id).not.toBe(
      tick!.spanContext().spanId,
    );
  });

  // The cache counters are emitted only from a cached read, so on a service
  // that has just booted — or during a quiet window on a dashboard's time
  // range — the series does not exist and OpenObserve renders "Error Loading
  // Data". The reasoning is spelled out in business-metrics.ts for the error
  // and business counters; the cache counters have exactly the same shape and
  // need exactly the same seeding.
  //
  // hit/miss/bypass are seeded, but NOT cache_operation_duration_ms: that one
  // is a duration, and a seeded 0ms would drag every average and percentile
  // toward zero — the panel would read "fast" precisely when nothing ran.
  it("seeds cache_requests_total at zero for every Result value", async () => {
    const d = makeDeps({ password: 1, passwordless: 1 });
    const poller = new BusinessMetricsPoller(d as any);

    await poller.collectAndPublish();

    for (const result of ["hit", "miss", "bypass"]) {
      expect(d.publish).toHaveBeenCalledWith("cache_requests_total", 0, {
        Service: "users",
        KeyPrefix: "users:me:v1",
        Result: result,
      });
    }
  });

  it("does NOT seed the duration histogram", async () => {
    const d = makeDeps({ password: 1, passwordless: 1 });
    const poller = new BusinessMetricsPoller(d as any);

    await poller.collectAndPublish();

    expect(d.publish).not.toHaveBeenCalledWith(
      "cache_operation_duration_ms",
      0,
      expect.anything(),
      expect.anything(),
    );
  });
});
