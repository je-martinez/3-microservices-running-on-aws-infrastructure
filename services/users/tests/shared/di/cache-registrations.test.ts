import { describe, it, expect, beforeAll } from "vitest";
import { diContainer } from "@fastify/awilix";
import { registerSingletons } from "#shared/di/awilix-container";
import { CacheGateway } from "#shared/cache/cache-gateway";

describe("cache DI registrations", () => {
  beforeAll(() => {
    registerSingletons();
  });

  it("resolves cacheGateway, walking the redis + metricsPublisher chain", () => {
    expect(diContainer.resolve("cacheGateway")).toBeInstanceOf(CacheGateway);
  });

  it("returns the same instance twice — SINGLETON, sharing the one ioredis socket", () => {
    // Not a style assertion. A per-request gateway would be harmless on its own
    // (it holds no connection), but the registration must resolve the SINGLETON
    // `redis` rather than ever constructing a second client.
    expect(diContainer.resolve("cacheGateway")).toBe(diContainer.resolve("cacheGateway"));
    expect(diContainer.resolve("redis")).toBe(diContainer.resolve("redis"));
  });
});
