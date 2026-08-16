import { MongoClient } from "mongodb";
import { docdbEchoCommands, env } from "#shared/config/env";
import { attachCommandLogging } from "#shared/db/command-logger";

// Module-scope singleton — created OUTSIDE the handler so it is reused across
// warm-container invocations, per the milestone design spec's "DocumentDB
// client" section. Caching the connect() PROMISE (not the resolved client)
// also collapses concurrent first calls into a single connection attempt.
//
// No transactions: the flow is one insert plus single-document $set/$push
// updates, each atomic in MongoDB on its own. Floci's standalone mongo:7.0
// container has no replica set and cannot run multi-document transactions
// anyway (real AWS DocumentDB can, from engine 4.0+) — see
// docs/lessons/floci-sqs-lambda-docdb-support.md.
let clientPromise: Promise<MongoClient> | undefined;

export function getMongoClient(): Promise<MongoClient> {
  if (!clientPromise) {
    // authSource is appended only when configured: without it the driver
    // authenticates against DOCDB_DATABASE, which is right for Amazon
    // DocumentDB but fails against Floci's stock mongo:7.0, whose root user
    // lives in `admin` (see DOCDB_AUTH_SOURCE in #shared/config/env).
    const authSource = env.DOCDB_AUTH_SOURCE ? `&authSource=${env.DOCDB_AUTH_SOURCE}` : "";
    const client = new MongoClient(
      `mongodb://${env.DOCDB_USERNAME}:${env.DOCDB_PASSWORD}@${env.DOCDB_HOST}:${env.DOCDB_PORT}/${env.DOCDB_DATABASE}?tls=false${authSource}`,
      // Command monitoring is what feeds #shared/db/command-logger. Enabled only
      // when the echo is on: with no listeners the driver would still construct
      // and emit an event object per command for nobody to read.
      { monitorCommands: docdbEchoCommands },
    );
    // Attached HERE, inside the `if (!clientPromise)` branch, so it runs exactly
    // ONCE per client. This function is called on every invocation and returns
    // the cached client from a warm container; attaching per call would stack a
    // fresh set of listeners each time and emit every command N times — the same
    // double-emission that SQLAlchemy's `echo=True` produced in Tracking, and the
    // reason that service builds its echo through the logger instead
    // (services/tracking/src/shared/db/engine.py).
    if (docdbEchoCommands) attachCommandLogging(client);
    // If the connection fails, drop the cached rejected promise so the next
    // invocation retries instead of replaying the same failure forever from a
    // warm container.
    clientPromise = client.connect().catch((err: unknown) => {
      clientPromise = undefined;
      throw err;
    });
  }
  return clientPromise;
}
