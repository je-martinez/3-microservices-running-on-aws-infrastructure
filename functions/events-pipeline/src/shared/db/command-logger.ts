import type { MongoClient } from "mongodb";
import type { CommandFailedEvent, CommandStartedEvent, CommandSucceededEvent } from "mongodb";
import { docdbEchoCommands } from "#shared/config/env";
import { appLogger } from "#shared/logging/app-logger";

// Commands the DRIVER issues on its own, over the same monitoring channel as
// application queries. None of them is a query this service asked for:
//
//  - hello / ismaster / isMaster: the handshake and the topology monitor's
//    heartbeat, re-sent every heartbeatFrequencyMS (10s by default) per server,
//    forever, including while the Lambda is doing nothing.
//  - ping: the driver's liveness probe (and what MongoClient.connect() uses).
//  - endSessions / killCursors: session and cursor bookkeeping on teardown.
//  - saslStart / saslContinue / authenticate / getnonce: the auth exchange.
//    Excluded for a second reason beyond noise — these carry credential
//    material, and the whole point of the shape below is that nothing from a
//    command body reaches a log line.
//
// Left in, the heartbeat alone would out-produce the actual queries by an order
// of magnitude in an idle container and make the docdb stream useless.
const DRIVER_INTERNAL_COMMANDS = new Set([
  "hello",
  "ismaster",
  "isMaster",
  "ping",
  "endSessions",
  "killCursors",
  "saslStart",
  "saslContinue",
  "authenticate",
  "getnonce",
]);

// The command document's FIRST key is the command name, and its value is the
// collection the command targets ({ insert: "events", documents: [...] }).
// Reading it off the event is how we name the collection without touching the
// rest of the body.
//
// Commands that target a database rather than a collection (e.g. `createIndexes`
// on some shapes, admin commands) carry a non-string value there; those simply
// get no collection field rather than a garbage one.
function collectionOf(event: CommandStartedEvent): string | undefined {
  const value = event.command?.[event.commandName];
  return typeof value === "string" ? value : undefined;
}

/**
 * The routed statement field.
 *
 * `db_statement` is not a decorative name: it is what the collector's
 * `filter/only_docdb` tests for to send a record to the `docdb` stream, beside
 * the DocumentDB cluster's own engine logs.
 *
 * IT MUST NOT BE CALLED `commandText`. That is the field `filter/only_sql`
 * routes on, so a record carrying it would be claimed by the sql pipeline TOO —
 * those two filters are complements of each other, not of this one, and the
 * line would be stored in two streams at once. These are document-store
 * commands; they belong with DocumentDB, not with Tracking's and Orders'
 * relational statements.
 *
 * The value is deliberately just "<commandName> <collection>" — a shape, not a
 * statement.
 *
 * THE BODY IS DELIBERATELY OMITTED. A `commandStarted` event carries the full
 * command document: for `insert` that is the event being stored (whose payload
 * carries user emails), and for `find`/`updateOne` it is the filter with its
 * literal values. Logging any of it would put PII in the log stream, which
 * [[logging-context]] forbids outright — and the diagnostic value people
 * actually want from these lines (which command, against what, how long) does
 * not need it.
 */
function dbStatement(commandName: string, collection: string | undefined): string {
  return collection ? `${commandName} ${collection}` : commandName;
}

// The started event is what knows the collection; the succeeded/failed events
// only carry `commandName` and `requestId`. Correlating on `requestId` is what
// lets the completion line name the collection too. Bounded by construction:
// every started command ends in exactly one succeeded or failed event, and both
// paths delete their entry.
//
// A miss (a command whose start was never seen, e.g. one issued before the
// listeners were attached) simply yields no collection — never a wrong one.
const inFlight = new Map<number, string | undefined>();

/**
 * Attach the command-monitoring listeners to `client`.
 *
 * Call EXACTLY ONCE per client, at construction. `getMongoClient` caches a
 * single client across warm invocations, so attaching per call would add a
 * duplicate set of listeners on every invocation and emit each command N times
 * — the same double-emission failure SQLAlchemy's `echo=True` caused in Tracking
 * (see services/tracking/src/shared/db/engine.py), reached by a different route.
 *
 * Everything is logged through THIS PACKAGE'S logger (#shared/logging), never
 * `console.log`, so each line carries `service_name`, the OTel severity fields
 * and the per-record AsyncLocalStorage context — including `request_id`, which
 * with no OpenTelemetry SDK here is the only link from a command back to the
 * request that ultimately caused the email.
 *
 * A no-op when the echo is off. The caller already checks the same flag (it also
 * decides `monitorCommands`, without which no event is emitted at all), but the
 * guarantee "the flag off means no line" belongs to this module rather than to
 * every future caller remembering to ask.
 */
export function attachCommandLogging(client: MongoClient): void {
  if (!docdbEchoCommands) return;

  client.on("commandStarted", (event: CommandStartedEvent) => {
    if (DRIVER_INTERNAL_COMMANDS.has(event.commandName)) return;

    const collection = collectionOf(event);
    inFlight.set(event.requestId, collection);

    // INFO, not DEBUG. Pino's default level is `info` and nothing in this
    // service raises it, so a DEBUG line here would be dropped before it ever
    // reached stdout — a gate that looks enabled and emits nothing. Volume is
    // controlled by DOCDB_ECHO_COMMANDS below, not by the severity, which is
    // also how Tracking's SQL echo works (SQLAlchemy emits at INFO).
    appLogger.info(
      {
        db_statement: dbStatement(event.commandName, collection),
        db_command: event.commandName,
        db_collection: collection,
        db_name: event.databaseName,
      },
      "db command started",
    );
  });

  client.on("commandSucceeded", (event: CommandSucceededEvent) => {
    if (DRIVER_INTERNAL_COMMANDS.has(event.commandName)) return;

    const collection = inFlight.get(event.requestId);
    inFlight.delete(event.requestId);

    appLogger.info(
      {
        db_statement: dbStatement(event.commandName, collection),
        db_command: event.commandName,
        db_collection: collection,
        db_name: event.databaseName,
        // The driver's own measurement of the round trip, which is the number
        // worth having here — `duration_ms` is the shared context's name for it.
        duration_ms: event.duration,
      },
      "db command succeeded",
    );
  });

  client.on("commandFailed", (event: CommandFailedEvent) => {
    if (DRIVER_INTERNAL_COMMANDS.has(event.commandName)) return;

    const collection = inFlight.get(event.requestId);
    inFlight.delete(event.requestId);

    // ERROR, not DEBUG: a failed write to the event store is a real problem, and
    // one that must be visible even when the gate below is the only reason the
    // successful commands are being emitted at all.
    //
    // `failure.name` ONLY, never the message and never `err`. A Mongo driver
    // error's message EMBEDS THE REJECTED DOCUMENT — passing the error itself
    // would defeat the whole omit-the-body rule above by the back door (the same
    // reduction src/handler.ts already applies to driver errors).
    appLogger.error(
      {
        db_statement: dbStatement(event.commandName, collection),
        db_command: event.commandName,
        db_collection: collection,
        db_name: event.databaseName,
        duration_ms: event.duration,
        app_event: "db_command_failed",
        reason: event.failure?.name ?? "Error",
      },
      "db command failed",
    );
  });
}

/** Test seam — the in-flight map is module state shared by all clients. */
export function resetCommandLoggingForTests(): void {
  inFlight.clear();
}
