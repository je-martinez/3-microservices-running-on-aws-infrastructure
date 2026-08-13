/**
 * Resolves the metrics registrations THROUGH the real Awilix container.
 *
 * Why this file exists: every other metrics test constructs the class directly
 * with a hand-built double, which never exercises the registration itself. That
 * gap shipped a real outage — `metricsPublisher` was registered with `asClass`,
 * whose PROXY injection resolves each destructured constructor parameter as a
 * cradle KEY. `MetricsPublisher` takes `{ client }`, no `client` is registered,
 * and so resolution threw `AwilixResolutionError: Could not resolve 'client'`.
 *
 * Nothing caught it: it is a RESOLUTION-time failure, not an import-time one, so
 * typecheck, lint and 333 green unit tests all passed while the service died on
 * boot and the gateway answered 502.
 *
 * These tests resolve from the container for real, so a wiring mistake fails
 * here instead of at startup.
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
