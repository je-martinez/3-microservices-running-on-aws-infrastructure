import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { symbols } from "pino";
import { testSpanExporter } from "../setup.ts";
import { appLogger } from "#shared/logging/app-logger";
import { AUTH_PROVIDER, DB } from "#shared/tokens";
import {
  DeleteAccountCommand,
  DeleteAccountHandler,
} from "../../src/users/commands/delete-account.command.ts";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { CascadeClient, CascadeFailedError, CascadeUnavailableError } from "#shared/http/cascade-client";
import { CacheGateway } from "#shared/cache/cache-gateway";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { AuditActor } from "#shared/audit/audit-actor";
import { getActor } from "#shared/audit/actor-context";
import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";
import { RoutineFailure } from "#shared/observability/workflow-metadata";

const TARGET = {
  id: "usr_1",
  email: "a@b.co",
  cognitoSub: "sub-1",
  fullName: "A",
};

type CapturedLine = Record<string, unknown>;

async function captureAppLogs(fn: () => Promise<void>): Promise<CapturedLine[]> {
  const lines: string[] = [];
  const logger = appLogger as unknown as Record<symbol, unknown>;
  const original = logger[symbols.streamSym];
  logger[symbols.streamSym] = { write: (s: string) => lines.push(s) };
  try {
    await fn();
  } finally {
    logger[symbols.streamSym] = original;
  }
  return lines.map((line) => JSON.parse(line) as CapturedLine);
}

function lineFor(lines: CapturedLine[], appEvent: string): CapturedLine | undefined {
  return lines.find((l) => l.app_event === appEvent);
}

async function buildBus(
  overrides: {
    resolved?: unknown;
    ordersFails?: boolean;
    trackingFails?: boolean;
    cognitoFails?: boolean;
    cacheFails?: boolean;
    omitCache?: boolean;
  } = {},
) {
  const resolved =
    "resolved" in overrides
      ? overrides.resolved
      : TARGET;
  const seenActor: { value?: string } = {};
  const order: string[] = [];
  const db = {
    user: {
      delete: vi.fn(async () => {
        seenActor.value = getActor();
        order.push("users");
        return TARGET;
      }),
    },
  };
  const cascade = {
    deleteOrdersForUser: vi.fn(async () => {
      if (overrides.ordersFails) throw new CascadeFailedError("orders", "status 500");
      order.push("orders");
    }),
    deleteTrackingsForUser: vi.fn(async () => {
      if (overrides.trackingFails) throw new CascadeFailedError("tracking", "status 503");
      order.push("tracking");
    }),
  };
  const auth = {
    deleteUser: vi.fn(async () => {
      if (overrides.cognitoFails) throw new Error("cognito down");
      order.push("cognito");
    }),
  };
  const metrics = { publish: vi.fn(async () => {}) };
  const cacheGateway = {
    invalidate: vi.fn(async () => {
      if (overrides.cacheFails) throw new Error("redis down");
    }),
  };

  const providers: unknown[] = [
    { provide: DB, useValue: db },
    { provide: CascadeClient, useValue: cascade },
    { provide: AUTH_PROVIDER, useValue: auth },
    { provide: MetricsPublisher, useValue: metrics },
    DeleteAccountHandler,
    { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
  ];
  if (!overrides.omitCache) {
    providers.splice(4, 0, { provide: CacheGateway, useValue: cacheGateway });
  }

  @Module({
    imports: [CqrsModule],
    providers: providers as never[],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return {
    bus: moduleRef.get(CommandBus),
    db,
    cascade,
    auth,
    metrics,
    cacheGateway,
    seenActor,
    order,
    currentUser: { resolve: vi.fn(async () => resolved) },
    close: () => moduleRef.close(),
  };
}

function span() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "delete_account");
}

describe("DeleteAccountCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("cascades to BOTH services before deleting the account", async () => {
    const { bus, currentUser, order, close } = await buildBus();
    const result = await bus.execute(new DeleteAccountCommand(currentUser as never));
    expect(result).toBe("deleted");
    expect(order).toEqual(["orders", "tracking", "users", "cognito"]);
    await close();
  });

  it("passes both identities to Tracking", async () => {
    const { bus, cascade, currentUser, close } = await buildBus();
    await bus.execute(new DeleteAccountCommand(currentUser as never));
    expect(cascade.deleteTrackingsForUser).toHaveBeenCalledWith("sub-1", "usr_1");
    await close();
  });

  it("stamps the DeleteAccount audit actor", async () => {
    const { bus, seenActor, currentUser, close } = await buildBus();
    await bus.execute(new DeleteAccountCommand(currentUser as never));
    expect(seenActor.value).toBe(AuditActor.DeleteAccount);
    await close();
  });

  it("returns not_found and touches nothing when the user does not exist", async () => {
    const { bus, cascade, db, auth, currentUser, close } = await buildBus({ resolved: null });
    const result = await bus.execute(new DeleteAccountCommand(currentUser as never));
    expect(result).toBe("not_found");
    expect(result).not.toBeInstanceOf(RoutineFailure);
    expect(cascade.deleteOrdersForUser).not.toHaveBeenCalled();
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
    await close();
  });

  it("does NOT delete the account when the Orders cascade fails", async () => {
    const { bus, db, auth, currentUser, close } = await buildBus({ ordersFails: true });
    await expect(
      bus.execute(new DeleteAccountCommand(currentUser as never)),
    ).rejects.toBeInstanceOf(CascadeFailedError);
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
    await close();
  });

  it("does NOT delete the account when the Tracking cascade fails", async () => {
    const { bus, db, currentUser, close } = await buildBus({ trackingFails: true });
    await expect(
      bus.execute(new DeleteAccountCommand(currentUser as never)),
    ).rejects.toBeInstanceOf(CascadeFailedError);
    expect(db.user.delete).not.toHaveBeenCalled();
    await close();
  });

  it("still reports success when Cognito fails after the row is stamped", async () => {
    const { bus, db, currentUser, close } = await buildBus({ cognitoFails: true });
    const result = await bus.execute(new DeleteAccountCommand(currentUser as never));
    expect(result).toBe("deleted");
    expect(db.user.delete).toHaveBeenCalled();
    await close();
  });

  it("logs the started/succeeded triad with email_hash and user_id", async () => {
    const { bus, currentUser, close } = await buildBus();
    const lines = await captureAppLogs(async () => {
      await bus.execute(new DeleteAccountCommand(currentUser as never));
    });
    const started = lineFor(lines, "delete_account_started");
    const succeeded = lineFor(lines, "delete_account_succeeded");
    expect(started).toBeDefined();
    expect(succeeded).toBeDefined();
    expect(started!.user_id).toBe("usr_1");
    expect(started!.email_hash).toBeTypeOf("string");
    expect(JSON.stringify(lines)).not.toContain("a@b.co");
    await close();
  });

  it("logs a failed line naming WHICH cascade leg did not confirm", async () => {
    const { bus, currentUser, close } = await buildBus({ trackingFails: true });
    const lines = await captureAppLogs(async () => {
      await bus.execute(new DeleteAccountCommand(currentUser as never)).catch(() => undefined);
    });
    const failed = lineFor(lines, "delete_account_failed");
    expect(failed).toBeDefined();
    expect(failed!.reason).toBe("cascade_failed_tracking");
    expect(failed!.severity_text).toBe("ERROR");
    await close();
  });

  it("logs a failed line with reason not_found for an unknown user", async () => {
    const { bus, currentUser, close } = await buildBus({ resolved: null });
    const lines = await captureAppLogs(async () => {
      await bus.execute(new DeleteAccountCommand(currentUser as never));
    });
    const failed = lineFor(lines, "delete_account_failed");
    expect(failed!.reason).toBe("not_found");
    expect(span()!.attributes.reason).toBe("not_found");
    expect(span()!.status.code).not.toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("refuses to cascade a user with no cognito sub, naming the real reason", async () => {
    const { bus, cascade, db, currentUser, close } = await buildBus({
      resolved: { ...TARGET, cognitoSub: null },
    });
    const lines = await captureAppLogs(async () => {
      await bus.execute(new DeleteAccountCommand(currentUser as never)).catch(() => undefined);
    });
    expect(cascade.deleteOrdersForUser).not.toHaveBeenCalled();
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(lineFor(lines, "delete_account_failed")?.reason).toBe("missing_cognito_sub");
    expect(span()!.attributes.reason).toBe("missing_cognito_sub");
    await close();
  });

  it("blames no downstream service when the cascade was never attempted", async () => {
    const { bus, cascade, currentUser, close } = await buildBus({
      resolved: { ...TARGET, cognitoSub: null },
    });
    const error = await bus
      .execute(new DeleteAccountCommand(currentUser as never))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CascadeUnavailableError);
    expect(error).not.toBeInstanceOf(CascadeFailedError);
    expect(String((error as Error).message)).not.toContain("orders");
    expect(cascade.deleteOrdersForUser).not.toHaveBeenCalled();
    expect(cascade.deleteTrackingsForUser).not.toHaveBeenCalled();
    await close();
  });

  it("publishes the users_deleted_total counter", async () => {
    const { bus, metrics, currentUser, close } = await buildBus();
    await bus.execute(new DeleteAccountCommand(currentUser as never));
    expect(metrics.publish).toHaveBeenCalledWith("users_deleted_total", 1, { Service: "users" });
    await close();
  });

  it("does not publish the counter when the cascade fails", async () => {
    const { bus, metrics, currentUser, close } = await buildBus({ ordersFails: true });
    await bus.execute(new DeleteAccountCommand(currentUser as never)).catch(() => undefined);
    expect(metrics.publish).not.toHaveBeenCalled();
    await close();
  });

  it("drops the deleted user's cached profile", async () => {
    const { bus, cacheGateway, currentUser, close } = await buildBus();
    await bus.execute(new DeleteAccountCommand(currentUser as never));
    expect(cacheGateway.invalidate).toHaveBeenCalledWith(
      ME_KEY_PREFIX,
      meCacheKey("sub-1", "usr_1"),
    );
    await close();
  });

  it("invalidates only AFTER the row is deleted", async () => {
    const { bus, db, cacheGateway, currentUser, close } = await buildBus();
    const seq: string[] = [];
    db.user.delete.mockImplementation(async () => {
      seq.push("delete");
      return TARGET;
    });
    cacheGateway.invalidate.mockImplementation(async () => {
      seq.push("invalidate");
    });
    await bus.execute(new DeleteAccountCommand(currentUser as never));
    expect(seq.indexOf("delete")).toBeLessThan(seq.indexOf("invalidate"));
    await close();
  });

  it("uses the read path's exact key: both cognito_sub and user_id", async () => {
    const { bus, cacheGateway, currentUser, close } = await buildBus();
    await bus.execute(new DeleteAccountCommand(currentUser as never));
    expect(cacheGateway.invalidate.mock.calls[0]).toEqual([
      ME_KEY_PREFIX,
      meCacheKey("sub-1", "usr_1"),
    ]);
    await close();
  });

  it("still reports success when Redis fails during invalidation", async () => {
    const { bus, currentUser, close } = await buildBus({ cacheFails: true });
    const lines = await captureAppLogs(async () => {
      await expect(
        bus.execute(new DeleteAccountCommand(currentUser as never)),
      ).resolves.toBe("deleted");
    });
    expect(lineFor(lines, "delete_account_succeeded")).toBeDefined();
    const warn = lineFor(lines, "cache_unavailable");
    expect(warn?.severity_text).toBe("WARN");
    expect(warn?.reason).toBe("redis_error");
    expect(JSON.stringify(lines)).not.toContain(meCacheKey("sub-1", "usr_1"));
    await close();
  });

  it("deletes the account when no cacheGateway is registered at all", async () => {
    const { bus, db, currentUser, close } = await buildBus({ omitCache: true });
    await expect(
      bus.execute(new DeleteAccountCommand(currentUser as never)),
    ).resolves.toBe("deleted");
    expect(db.user.delete).toHaveBeenCalled();
    await close();
  });

  it("emits delete_account_succeeded on success", async () => {
    const { bus, currentUser, close } = await buildBus();
    await bus.execute(new DeleteAccountCommand(currentUser as never));
    expect(span()).toBeDefined();
    expect(span()!.attributes.app_event).toBe("delete_account_succeeded");
    expect(span()!.attributes.user_id).toBe("usr_1");
    expect(span()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("passes both identities to Orders as well as Tracking", async () => {
    const { bus, cascade, currentUser, close } = await buildBus();
    await bus.execute(new DeleteAccountCommand(currentUser as never));
    expect(cascade.deleteOrdersForUser).toHaveBeenCalledWith("sub-1", "usr_1");
    expect(cascade.deleteTrackingsForUser).toHaveBeenCalledWith("sub-1", "usr_1");
    await close();
  });
});
