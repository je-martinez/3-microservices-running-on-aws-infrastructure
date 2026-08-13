import { describe, it, expect, vi } from "vitest";
import { BusinessMetricsPoller } from "#shared/metrics/business-metrics";

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
});
