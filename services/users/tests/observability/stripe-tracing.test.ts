import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { testSpanExporter } from "../setup.ts";
import { withStripeSpan } from "#shared/observability/stripe-tracing";

function spanNamed(name: string) {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === name);
}

describe("withStripeSpan", () => {
  beforeEach(() => testSpanExporter.reset());

  it("names the span after the operation, kind CLIENT, with the given attributes", async () => {
    const result = await withStripeSpan(
      "stripe.customer.create",
      { "stripe.resource_type": "customer" },
      async (handle) => {
        handle.setAttribute("stripe.customer_id", "cus_123");
        return "ok";
      },
    );

    expect(result).toBe("ok");

    const span = spanNamed("stripe.customer.create");
    expect(span).toBeDefined();
    expect(span!.kind).toBe(SpanKind.CLIENT);
    expect(span!.attributes["stripe.operation"]).toBe("stripe.customer.create");
    expect(span!.attributes["stripe.resource_type"]).toBe("customer");
    expect(span!.attributes["stripe.customer_id"]).toBe("cus_123");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
    expect(span!.ended).toBe(true);
  });

  it("sets ERROR status and records the exception when fn throws, then still ends the span", async () => {
    await expect(
      withStripeSpan("stripe.payment_method.attach", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const span = spanNamed("stripe.payment_method.attach");
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe("boom");
    expect(span!.events.some((e) => e.name === "exception")).toBe(true);
    expect(span!.ended).toBe(true);
    expect(testSpanExporter.getFinishedSpans().filter((s) => s.name === "stripe.payment_method.attach")).toHaveLength(
      1,
    );
  });
});
