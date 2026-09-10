import type { MongoClient } from "mongodb";
import type { CommandFailedEvent, CommandStartedEvent, CommandSucceededEvent } from "mongodb";
import { docdbEchoCommands } from "#shared/config/env";
import { appLogger } from "#shared/logging/app-logger";

// CONTRACT: Driver-internal commands, filtered out — none is a query this
// service issued. Do NOT remove the sasl/authenticate entries: those carry
// credential material. The heartbeat alone out-produces real queries by an order
// of magnitude in an idle container and makes the docdb stream useless.
// See [[logging-context]]
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

// The command document's first key is the command name and its value is the
// target collection ({ insert: "events", ... }), so the collection is readable
// without touching the rest of the body. A command targeting a database rather
// than a collection carries a non-string value there and gets no field at all.
function collectionOf(event: CommandStartedEvent): string | undefined {
  const value = event.command?.[event.commandName];
  return typeof value === "string" ? value : undefined;
}

/**
 * The routed statement field.
 *
 * CONTRACT: The field is `db_statement`, never `commandText`. The collector's
 * `filter/only_docdb` routes on the former and `filter/only_sql` on the latter,
 * so the wrong name stores the line in both streams at once.
 *
 * WARNING: PII. The value is a SHAPE ("<commandName> <collection>"), never the
 * command body — a `commandStarted` event carries the full document, which for
 * an `insert` is the event payload with its user emails.
 * See [[logging-context]]
 */
function dbStatement(commandName: string, collection: string | undefined): string {
  return collection ? `${commandName} ${collection}` : commandName;
}

// Only the started event knows the collection, so the completion lines
// correlate on `requestId`. Bounded by construction: every started command ends
// in exactly one succeeded or failed event, and both delete their entry. A miss
// yields no collection, never a wrong one.
const inFlight = new Map<number, string | undefined>();

/**
 * Attach the command-monitoring listeners to `client`.
 *
 * CONTRACT: Call EXACTLY ONCE per client, at construction. `getMongoClient`
 * caches one client across warm invocations, so attaching per call stacks a
 * duplicate listener set each time and emits every command N times.
 *
 * CONTRACT: Log through this package's logger, never `console.log` — that is
 * what carries `service_name`, the OTel severity fields and the per-record
 * AsyncLocalStorage context. A no-op when the echo flag is off.
 * See [[logging-context]]
 */
export function attachCommandLogging(client: MongoClient): void {
  if (!docdbEchoCommands) return;

  client.on("commandStarted", (event: CommandStartedEvent) => {
    if (DRIVER_INTERNAL_COMMANDS.has(event.commandName)) return;

    const collection = collectionOf(event);
    inFlight.set(event.requestId, collection);

    // CONTRACT: INFO, not DEBUG. Pino's level is `info` and nothing raises it,
    // so a DEBUG line is dropped before stdout — a gate that looks enabled and
    // emits nothing. Volume is controlled by DOCDB_ECHO_COMMANDS.
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

    // ERROR, not DEBUG: a failed write to the event store must stay visible
    // regardless of the echo gate.
    // CONTRACT: `failure.name` only — never the message, never `err`. A Mongo
    // driver error's message embeds the REJECTED DOCUMENT.
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
