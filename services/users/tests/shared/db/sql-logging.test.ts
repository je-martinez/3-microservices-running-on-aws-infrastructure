import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { attachSqlLogging, type PrismaQueryEvent } from "#shared/db/sql-logging";

// CONTRACT: The collector routes these lines to the `sql` stream on the MESSAGE
// starting with a SQL keyword, so the shape asserted here is a contract.
// See [[logging-context]]

function fakeClient() {
  let handler: ((event: PrismaQueryEvent) => void) | undefined;
  return {
    $on(_type: "query", cb: (event: PrismaQueryEvent) => void) {
      handler = cb;
      return undefined;
    },
    emit(event: PrismaQueryEvent) {
      handler?.(event);
    },
    get subscribed() {
      return handler !== undefined;
    },
  };
}

function fakeLogger() {
  const info = vi.fn();
  return { info, logger: { info } as unknown as Logger };
}

describe("attachSqlLogging", () => {
  it("logs the statement AS THE MESSAGE, with duration_ms as a field", () => {
    const client = fakeClient();
    const { info, logger } = fakeLogger();

    attachSqlLogging(client, { enabled: true, logger });
    client.emit({ query: 'SELECT "id" FROM "user" WHERE "email" = $1', duration: 3 });

    expect(info).toHaveBeenCalledOnce();
    const [fields, message] = info.mock.calls[0]!;
    expect(message).toBe('SELECT "id" FROM "user" WHERE "email" = $1');
    expect(fields).toEqual({ duration_ms: 3 });
  });

  it("NEVER emits parameter values", () => {
    // `params` carries emails, reset codes and tokens. See [[logging-context]]
    const client = fakeClient();
    const { info, logger } = fakeLogger();

    attachSqlLogging(client, { enabled: true, logger });
    client.emit({
      query: 'SELECT "id" FROM "user" WHERE "email" = $1',
      params: '["victim@example.com"]',
      duration: 1,
    });

    expect(JSON.stringify(info.mock.calls[0])).not.toContain("victim@example.com");
  });

  it("subscribes to nothing when disabled", () => {
    // WHY: The gate prevents the SUBSCRIPTION, not just the write — a listener
    // that fires and discards still pays per-query serialization.
    const client = fakeClient();

    attachSqlLogging(client, { enabled: false, logger: fakeLogger().logger });

    expect(client.subscribed).toBe(false);
  });
});

describe("echoSql default", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadEchoSql(): Promise<boolean> {
    vi.resetModules();
    return (await import("#shared/db/sql-logging")).echoSql;
  }

  it("is off in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await loadEchoSql()).toBe(false);
  });

  it("is on outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(await loadEchoSql()).toBe(true);
  });

  it("is on when NODE_ENV is unset", async () => {
    vi.stubEnv("NODE_ENV", undefined);
    expect(await loadEchoSql()).toBe(true);
  });

  it("decides an option-less attach, so production subscribes to nothing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { attachSqlLogging: attach } = await import("#shared/db/sql-logging");
    const client = fakeClient();

    attach(client);

    expect(client.subscribed).toBe(false);
  });
});
