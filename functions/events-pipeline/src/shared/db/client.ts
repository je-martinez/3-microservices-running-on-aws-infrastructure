import { MongoClient } from "mongodb";
import { docdbEchoCommands, env } from "#shared/config/env";
import { attachCommandLogging } from "#shared/db/command-logger";

// CONTRACT: Cache the connect() PROMISE, not the resolved client — that is what
// collapses concurrent first calls into one connection attempt across a warm
// container. No transactions: one insert plus single-document $set/$push, each
// atomic on its own. Floci's standalone mongo:7.0 has no replica set and cannot
// run multi-document transactions at all.
// See [[floci-sqs-lambda-docdb-support]]
let clientPromise: Promise<MongoClient> | undefined;

export function getMongoClient(): Promise<MongoClient> {
  if (!clientPromise) {
    // Appended only when configured — without it the driver authenticates
    // against DOCDB_DATABASE, right for real DocumentDB, wrong for Floci.
    const authSource = env.DOCDB_AUTH_SOURCE ? `&authSource=${env.DOCDB_AUTH_SOURCE}` : "";
    const client = new MongoClient(
      `mongodb://${env.DOCDB_USERNAME}:${env.DOCDB_PASSWORD}@${env.DOCDB_HOST}:${env.DOCDB_PORT}/${env.DOCDB_DATABASE}?tls=false${authSource}`,
      // Command monitoring is what feeds #shared/db/command-logger. Enabled only
      // when the echo is on: with no listeners the driver would still construct
      // and emit an event object per command for nobody to read.
      { monitorCommands: docdbEchoCommands },
    );
    // CONTRACT: Attach inside this branch, so it runs exactly ONCE per client.
    // A warm container returns the cached client on every invocation, so
    // attaching per call stacks listeners and emits every command N times.
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
