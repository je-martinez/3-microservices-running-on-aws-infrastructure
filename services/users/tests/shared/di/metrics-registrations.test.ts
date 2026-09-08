/**
 * Resolves the metrics registrations THROUGH the real Awilix container.
 *
 * CONTRACT: Resolve from the real container here. Every other metrics test builds the
 * class directly with a hand-built double, which never exercises the registration —
 * and an Awilix wiring mistake is a RESOLUTION-time failure, so typecheck, lint and a
 * fully green unit suite all pass while the service dies on boot and the gateway
 * answers 502. See [[mocks-hide-schema-bugs]]
 */
import { describe, it, expect, beforeAll } from "vitest";
import { diContainer } from "@fastify/awilix";
import { registerSingletons } from "#shared/di/awilix-container";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { BusinessMetricsPoller } from "#shared/metrics/business-metrics";

describe("metrics DI registrations", () => {
  beforeAll(() => {
    registerSingletons();
  });

  it("resolves metricsPublisher from the container", () => {
    const publisher = diContainer.resolve("metricsPublisher");

    expect(publisher).toBeInstanceOf(MetricsPublisher);
  });

  it("resolves businessMetricsPoller, whose dependency chain includes the publisher", () => {
    // The chain that actually broke: businessMetricsPoller -> metricsPublisher
    // -> client. Resolving the poller walks the whole path.
    const poller = diContainer.resolve("businessMetricsPoller");

    expect(poller).toBeInstanceOf(BusinessMetricsPoller);
  });

  it("returns the same instance twice — both are SINGLETON", () => {
    // Not a style assertion: a second BusinessMetricsPoller would own a second
    // interval timer, publishing the same gauge series twice per window and
    // reporting double the real count.
    expect(diContainer.resolve("businessMetricsPoller")).toBe(
      diContainer.resolve("businessMetricsPoller"),
    );
    expect(diContainer.resolve("metricsPublisher")).toBe(diContainer.resolve("metricsPublisher"));
  });
});
