import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheGateway } from "#shared/cache/cache-gateway";

const KEY_PREFIX = "users:me:v1";

function gatewayWith(del: (...keys: string[]) => Promise<number>) {
  const publish = vi.fn(async () => {});
  const gateway = new CacheGateway({
    redis: { del: vi.fn(del) } as never,
    metricsPublisher: { publish } as never,
    env: { CACHE_ENABLED: true } as never,
  });
  return { gateway, publish };
}

function durationCalls(publish: ReturnType<typeof vi.fn>) {
  return publish.mock.calls.filter(([name]) => name === "cache_operation_duration_ms");
}

// CONTRACT: Operation=del carries the elapsed time of the DEL on both paths, like
// get and set. A hard-coded duration leaves the series flat at 0 ms on the
// dashboard while a slow or failing invalidation goes unseen.
describe("CacheGateway.invalidate duration metric", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the measured duration when the DEL succeeds", async () => {
    const { gateway, publish } = gatewayWith(
      () => new Promise((resolve) => setTimeout(() => resolve(1), 20)),
    );

    const pending = gateway.invalidate(KEY_PREFIX, "users:me:v1:sub-a");
    await vi.advanceTimersByTimeAsync(20);
    await pending;

    expect(durationCalls(publish)).toEqual([
      [
        "cache_operation_duration_ms",
        20,
        { Service: "users", Operation: "del" },
        "Milliseconds",
      ],
    ]);
  });

  it("reports the measured duration, and resolves, when the DEL fails", async () => {
    const { gateway, publish } = gatewayWith(
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("ECONNREFUSED")), 30),
        ),
    );

    const pending = gateway.invalidate(KEY_PREFIX, "users:me:v1:sub-a");
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toBeUndefined();

    expect(durationCalls(publish)).toEqual([
      [
        "cache_operation_duration_ms",
        30,
        { Service: "users", Operation: "del" },
        "Milliseconds",
      ],
    ]);
    expect(publish).toHaveBeenCalledWith("cache_requests_total", 1, {
      Service: "users",
      KeyPrefix: KEY_PREFIX,
      Result: "bypass",
    });
  });

  it("reports the full timeout budget when the DEL never answers", async () => {
    const { gateway, publish } = gatewayWith(() => new Promise(() => {}));

    const pending = gateway.invalidate(KEY_PREFIX, "users:me:v1:sub-a");
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBeUndefined();

    expect(durationCalls(publish).map(([, durationMs]) => durationMs)).toEqual([50]);
  });
});
