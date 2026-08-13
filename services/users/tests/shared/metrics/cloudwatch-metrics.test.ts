import { describe, it, expect, vi } from "vitest";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";

function makeClient(sendImpl?: () => Promise<unknown>) {
  return { send: vi.fn(sendImpl ?? (async () => ({}))) };
}

describe("MetricsPublisher", () => {
  it("sends one datum with the 3MRAI namespace and the given dimensions", async () => {
    const client = makeClient();
    const publisher = new MetricsPublisher({ client: client as any });

    await publisher.publish("users_registered_total", 1, { Service: "users" });

    expect(client.send).toHaveBeenCalledTimes(1);
    const input = (client.send.mock.calls[0][0] as any).input;
    expect(input.Namespace).toBe("3MRAI");
    expect(input.MetricData).toHaveLength(1);
    expect(input.MetricData[0].MetricName).toBe("users_registered_total");
    expect(input.MetricData[0].Value).toBe(1);
    expect(input.MetricData[0].Unit).toBe("Count");
    // Dimensions travel as CloudWatch's list-of-{Name,Value}, and the exact set
    // matters: Floci returns an EMPTY result for a query whose dimensions differ.
    expect(input.MetricData[0].Dimensions).toEqual([{ Name: "Service", Value: "users" }]);
  });

  it("never throws when the client fails — a metric must not break the caller", async () => {
    const client = makeClient(async () => {
      throw new Error("CloudWatch is down");
    });
    const publisher = new MetricsPublisher({ client: client as any });

    await expect(
      publisher.publish("users_registered_total", 1, { Service: "users" }),
    ).resolves.toBeUndefined();
  });
});
