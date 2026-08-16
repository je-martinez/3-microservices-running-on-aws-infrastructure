import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { MongoClient } from "mongodb";

// #shared/config/env is Zod-parsed at MODULE LOAD (ADR-0014) and throws without
// the full DOCDB/SES set, and #shared/db/command-logger reaches it. The values
// must therefore exist before the dynamic import below. Same block as
// tests/shared/metrics/cloudwatch-metrics.test.ts.
vi.stubEnv("DOCDB_HOST", "docdb-test");
vi.stubEnv("DOCDB_USERNAME", "root");
vi.stubEnv("DOCDB_PASSWORD", "secret");
vi.stubEnv("DOCDB_DATABASE", "events");
vi.stubEnv("SES_FROM_ADDRESS", "noreply@example.com");
vi.stubEnv("ASSETS_BASE_URL", "http://assets.test/bucket");

// The lines are captured off the REAL appLogger's destination rather than by
// mocking it. That is the whole point of two of the assertions below: the task
// is precisely to prove these lines went through this package's logger (and so
// carry service_name and the severity fields) instead of a console.log, and a
// mocked logger would assert nothing about that.
//
// pino writes to a destination, never through console, so a console spy would
// capture nothing. `pino.destination` is stubbed before app-logger is imported,
// which is when the singleton is built.
const lines: string[] = [];
vi.mock("pino", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pino")>();
  const pino = actual.default;
  const stream = { write: (s: string) => void lines.push(s) };
  const wrapped = ((options?: unknown) =>
    pino(options as never, stream)) as unknown as typeof pino;
  return { ...actual, default: wrapped };
});

const { attachCommandLogging, resetCommandLoggingForTests } = await import(
  "#shared/db/command-logger"
);

/**
 * A stand-in for MongoClient's EventEmitter surface.
 *
 * `attachCommandLogging` only ever calls `client.on(...)`, so an EventEmitter is
 * a faithful substitute for the part of the client under test — and it lets each
 * test emit exact driver event shapes (including ones that are awkward to
 * provoke against a real server, like a failure) without a live DocumentDB.
 */
function fakeClient(): EventEmitter & MongoClient {
  return new EventEmitter() as EventEmitter & MongoClient;
}

/** A `commandStarted` payload in the driver's shape. */
function started(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 1,
    databaseName: "events",
    commandName: "insert",
    command: { insert: "events", documents: [] },
    address: "docdb-test:27017",
    ...overrides,
  };
}

function records() {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("attachCommandLogging", () => {
  beforeEach(() => {
    lines.length = 0;
    resetCommandLoggingForTests();
  });

  it("emits a line carrying db_statement — the field the collector routes on", () => {
    const client = fakeClient();
    attachCommandLogging(client);

    client.emit("commandStarted", started());

    // `db_statement` is not decorative: filter/only_sql selects a record for the
    // dedicated `sql` stream when attributes["db_statement"] is present. A Mongo
    // command name matches none of the SQL keywords the filter's OTHER branch
    // tests, so without this field the line would land in the main application
    // stream and drown the events it is meant to sit beside.
    const rec = records()[0];
    expect(rec.db_statement).toBe("insert events");
    expect(rec.db_command).toBe("insert");
    expect(rec.db_collection).toBe("events");
  });

  it("carries service_name and the severity fields — it went through the real logger", () => {
    const client = fakeClient();
    attachCommandLogging(client);

    client.emit("commandStarted", started());

    // A console.log would produce none of these. This is the assertion that
    // distinguishes "logged through #shared/logging" from "printed", which is
    // the failure Tracking hit when SQLAlchemy attached its own plain-text
    // handler and a third of the stream arrived with no service_name.
    const rec = records()[0];
    expect(rec.service_name).toBe("events-pipeline");
    expect(rec.severity_text).toBe("INFO");
    expect(rec.severity_number).toBe(9);
    expect(rec.timestamp).toBeDefined();
    // Pino's own numeric level must be gone, like every other line this service
    // emits — otherwise the record does not line up with the other services.
    expect(rec.level).toBeUndefined();
  });

  it("reports the duration from commandSucceeded", () => {
    const client = fakeClient();
    attachCommandLogging(client);

    client.emit("commandStarted", started({ requestId: 7 }));
    client.emit("commandSucceeded", {
      requestId: 7,
      databaseName: "events",
      commandName: "insert",
      duration: 12,
      reply: {},
      address: "docdb-test:27017",
    });

    const rec = records()[1];
    expect(rec.duration_ms).toBe(12);
    // The collection is correlated from the started event by requestId — the
    // succeeded event does not carry it.
    expect(rec.db_collection).toBe("events");
    expect(rec.db_statement).toBe("insert events");
  });

  it("logs a failed command at ERROR with only the error's NAME", () => {
    const client = fakeClient();
    attachCommandLogging(client);

    // A driver error's MESSAGE embeds the rejected document. This one carries a
    // recognisable value to prove the message never reaches the record.
    const failure = new Error(
      'E11000 duplicate key error: { email: "victim@example.com" }',
    );
    failure.name = "MongoServerError";

    client.emit("commandStarted", started({ requestId: 9 }));
    client.emit("commandFailed", {
      requestId: 9,
      databaseName: "events",
      commandName: "insert",
      duration: 4,
      failure,
      address: "docdb-test:27017",
    });

    const rec = records()[1];
    // A failed write to the event store is a real problem, so it outranks the
    // echo's own severity.
    expect(rec.severity_text).toBe("ERROR");
    expect(rec.app_event).toBe("db_command_failed");
    expect(rec.reason).toBe("MongoServerError");
    expect(JSON.stringify(rec)).not.toContain("victim@example.com");
  });

  it("never emits document contents or filter values", () => {
    const client = fakeClient();
    attachCommandLogging(client);

    // Both shapes that carry PII in this pipeline: the document being inserted
    // (whose payload holds user emails) and a filter's literal values.
    client.emit(
      "commandStarted",
      started({
        command: {
          insert: "events",
          documents: [
            { event_id: "evt_1", payload: { email: "victim@example.com" } },
          ],
        },
      }),
    );
    client.emit(
      "commandStarted",
      started({
        requestId: 2,
        commandName: "find",
        command: { find: "events", filter: { user_id: "usr_secret_value" } },
      }),
    );

    // Asserted against the SERIALIZED line, not the object handed to the logger:
    // a nested value that survived into the record would still show up here.
    const serialized = lines.join("");
    expect(serialized).not.toContain("victim@example.com");
    expect(serialized).not.toContain("usr_secret_value");
    // …while the diagnostic value is still there.
    expect(records()[0].db_statement).toBe("insert events");
    expect(records()[1].db_statement).toBe("find events");
  });

  it("emits nothing for the driver's own internal commands", () => {
    const client = fakeClient();
    attachCommandLogging(client);

    // The topology monitor re-sends hello/ismaster every heartbeat interval,
    // forever, including while the Lambda is idle — left in, they would
    // out-produce the real queries and make the sql stream useless.
    for (const commandName of ["hello", "ismaster", "isMaster", "ping", "endSessions"]) {
      client.emit("commandStarted", started({ commandName, command: { [commandName]: 1 } }));
      client.emit("commandSucceeded", {
        requestId: 1,
        databaseName: "admin",
        commandName,
        duration: 1,
        reply: {},
        address: "docdb-test:27017",
      });
    }

    expect(lines).toHaveLength(0);
  });

  it("names no collection for a command whose value is not a collection", () => {
    const client = fakeClient();
    attachCommandLogging(client);

    // An admin-style command targets a database, not a collection: its first
    // value is a 1, not a name. Better to omit the field than to log "1".
    client.emit(
      "commandStarted",
      started({ commandName: "dbStats", command: { dbStats: 1 } }),
    );

    const rec = records()[0];
    expect(rec.db_statement).toBe("dbStats");
    expect("db_collection" in rec).toBe(false);
  });
});

describe("attachCommandLogging with the echo flag OFF", () => {
  beforeEach(() => {
    lines.length = 0;
    // These tests re-import #shared/config/env under different flags, so the
    // module registry is reset — and the required vars are stubbed AGAIN here
    // rather than relying on the file-level block above, because the
    // `unstubAllEnvs` below clears those too. Without this, the re-import fails
    // Zod validation on DOCDB_PASSWORD/SES_FROM_ADDRESS instead of exercising
    // the flag.
    vi.stubEnv("DOCDB_HOST", "docdb-test");
    vi.stubEnv("DOCDB_USERNAME", "root");
    vi.stubEnv("DOCDB_PASSWORD", "secret");
    vi.stubEnv("DOCDB_DATABASE", "events");
    vi.stubEnv("SES_FROM_ADDRESS", "noreply@example.com");
    vi.stubEnv("ASSETS_BASE_URL", "http://assets.test/bucket");
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits nothing", async () => {
    vi.stubEnv("DOCDB_ECHO_COMMANDS", "false");
    // Re-imported after the stub because the flag is resolved once at module
    // load, like every other value in #shared/config/env (ADR-0014).
    const mod = await import("#shared/db/command-logger");

    const client = fakeClient();
    mod.attachCommandLogging(client);
    client.emit("commandStarted", started());
    client.emit("commandSucceeded", {
      requestId: 1,
      databaseName: "events",
      commandName: "insert",
      duration: 3,
      reply: {},
      address: "docdb-test:27017",
    });

    expect(lines).toHaveLength(0);
  });

  it("is OFF by default in production and ON by default outside it", async () => {
    // The gate mirrors Tracking's `Settings.echo_sql`: derived from the
    // environment, so a prod deploy does not need to remember a second variable.
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "production");
    const prod = await import("#shared/config/env");
    expect(prod.docdbEchoCommands).toBe(false);

    vi.resetModules();
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "local");
    const local = await import("#shared/config/env");
    expect(local.docdbEchoCommands).toBe(true);
  });

  it("lets an explicit true win over production", async () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "production");
    vi.stubEnv("DOCDB_ECHO_COMMANDS", "true");
    const mod = await import("#shared/config/env");
    expect(mod.docdbEchoCommands).toBe(true);
  });
});
