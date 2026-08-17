import { describe, it, expect, vi } from "vitest";
import { attachSqlLogging, type PrismaQueryEvent } from "#shared/db/sql-logging";

// The statement lines exist so "what SQL did this service run?" has an answer
// for Users the way it already does for Tracking and Orders. They are ROUTED to
// the dedicated `sql` stream by the collector, which is why the shape below is a
// contract rather than a preference — see filter/only_sql in
// observability/otel-collector-config.yaml.

/** A recording stand-in for Prisma's `$on("query", …)` surface. */
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
  return { info: vi.fn() } as never;
}

describe("attachSqlLogging", () => {
  it("logs the statement AS THE MESSAGE, which is what the collector routes on", () => {
    // filter/only_sql's first branch matches `message` starting with a SQL
    // keyword. Putting the statement in a FIELD instead would leave these lines
    // in the main application stream — the whole point is that they do not.
    const client = fakeClient();
    const logger = fakeLogger();

    attachSqlLogging(client, { enabled: true, logger });
    client.emit({ query: 'SELECT "id" FROM "user" WHERE "email" = $1', duration: 3 });

    const [fields, message] = (logger as unknown as { info: ReturnType<typeof vi.fn> }).info.mock
      .calls[0]!;
    expect(message).toMatch(/^SELECT\b/);
    expect(fields.duration_ms).toBe(3);
  });

  it("NEVER emits parameter values", () => {
    // `event.params` carries the bound values — for this service that means
    // emails, password-reset codes and tokens. [[logging-context]] forbids them
    // outright, and the statement text with its placeholders is the whole
    // diagnostic value.
    const client = fakeClient();
    const logger = fakeLogger();

    attachSqlLogging(client, { enabled: true, logger });
    client.emit({
      query: 'SELECT "id" FROM "user" WHERE "email" = $1',
      params: '["victim@example.com"]',
      duration: 1,
    });

    const serialized = JSON.stringify(
      (logger as unknown as { info: ReturnType<typeof vi.fn> }).info.mock.calls[0],
    );
    expect(serialized).not.toContain("victim@example.com");
  });

  it("subscribes to nothing when disabled", () => {
    // The gate has to prevent the SUBSCRIPTION, not just the write: a listener
    // that fires and discards still pays the serialization cost on every query.
    const client = fakeClient();

    attachSqlLogging(client, { enabled: false, logger: fakeLogger() });

    expect(client.subscribed).toBe(false);
  });
});
