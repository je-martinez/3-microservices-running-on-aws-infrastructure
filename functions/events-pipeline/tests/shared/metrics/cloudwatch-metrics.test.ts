import { describe, it, expect, vi, beforeEach } from "vitest";

// #shared/metrics/cloudwatch-metrics reaches #shared/config/env — Zod-parsed at
// MODULE LOAD (ADR-0014) and throwing without the full DOCDB/SES set. The values
// must therefore exist before the dynamic import of the module under test. None
// is read by this suite; they only satisfy the schema. Same block as
// tests/websocket-publisher.test.ts.
vi.stubEnv("DOCDB_HOST", "docdb-test");
vi.stubEnv("DOCDB_USERNAME", "root");
vi.stubEnv("DOCDB_PASSWORD", "secret");
vi.stubEnv("DOCDB_DATABASE", "events");
vi.stubEnv("SES_FROM_ADDRESS", "noreply@example.com");
vi.stubEnv("ASSETS_BASE_URL", "http://assets.test/bucket");

// Class stubs rather than aws-sdk-client-mock: the assertions are about the
// exact PutMetricData input, and capturing the command instance is what makes
// that readable. Same pattern as tests/websocket-publisher.test.ts.
const cwSend = vi.fn();
vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class {
    send = cwSend;
  },
  PutMetricDataCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { publishMetric, publishEmailMetric, resetMetricsClientForTests } = await import(
  "#shared/metrics/cloudwatch-metrics"
);

describe("publishMetric", () => {
  beforeEach(() => {
    cwSend.mockReset();
    cwSend.mockResolvedValue({});
    resetMetricsClientForTests();
  });

  it("sends one datum in the 3MRAI namespace with the given dimensions", async () => {
    await publishMetric("emails_sent_total", 1, {
      Service: "events-pipeline",
      EmailType: "user-created",
    });

    expect(cwSend).toHaveBeenCalledTimes(1);
    const input = (cwSend.mock.calls[0][0] as { input: Record<string, never> }).input as {
      Namespace: string;
      MetricData: {
        MetricName: string;
        Value: number;
        Unit: string;
        Dimensions: { Name: string; Value: string }[];
      }[];
    };
    expect(input.Namespace).toBe("3MRAI");
    expect(input.MetricData[0].MetricName).toBe("emails_sent_total");
    expect(input.MetricData[0].Value).toBe(1);
    expect(input.MetricData[0].Unit).toBe("Count");
    // Dimensions travel as CloudWatch's list-of-{Name,Value}, and the exact set
    // matters: Floci returns an EMPTY result (StatusCode "Complete", no error)
    // for a query whose dimensions differ from what was published.
    expect(input.MetricData[0].Dimensions).toEqual([
      { Name: "Service", Value: "events-pipeline" },
      { Name: "EmailType", Value: "user-created" },
    ]);
  });

  it("never throws when CloudWatch fails", async () => {
    cwSend.mockRejectedValue(new Error("CloudWatch is down"));

    // A metrics outage turned into a TransientError would make SQS redeliver a
    // record whose email work is already DONE — a duplicate for the customer.
    await expect(
      publishMetric("emails_sent_total", 1, { Service: "events-pipeline", EmailType: "ALL" }),
    ).resolves.toBeUndefined();
  });
});

describe("publishEmailMetric", () => {
  beforeEach(() => {
    cwSend.mockReset();
    cwSend.mockResolvedValue({});
    resetMetricsClientForTests();
  });

  it("publishes the per-type series AND the ALL rollup as two separate series", async () => {
    await publishEmailMetric("emails_failed_total", "user-created", {
      FailureKind: "transient",
    });

    // Two calls, not one: Floci does not aggregate across dimensions, so the
    // total must exist as its own published series.
    expect(cwSend).toHaveBeenCalledTimes(2);
    const dimensionSets = cwSend.mock.calls.map(
      (call) =>
        (call[0] as { input: { MetricData: { Dimensions: { Name: string; Value: string }[] }[] } })
          .input.MetricData[0].Dimensions,
    );
    expect(dimensionSets).toEqual([
      [
        { Name: "Service", Value: "events-pipeline" },
        { Name: "EmailType", Value: "user-created" },
        { Name: "FailureKind", Value: "transient" },
      ],
      [
        { Name: "Service", Value: "events-pipeline" },
        { Name: "EmailType", Value: "ALL" },
        { Name: "FailureKind", Value: "transient" },
      ],
    ]);
  });
});
