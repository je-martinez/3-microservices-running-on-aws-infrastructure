import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { BusinessMetricsPoller } from "#shared/metrics/business-metrics";
import { testSpanExporter } from "../../setup-tracing.ts";

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
