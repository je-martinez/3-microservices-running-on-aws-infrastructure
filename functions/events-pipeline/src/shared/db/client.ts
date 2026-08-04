import { MongoClient } from "mongodb";
import { env } from "#shared/config/env";

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
    const client = new MongoClient(
      `mongodb://${env.DOCDB_USERNAME}:${env.DOCDB_PASSWORD}@${env.DOCDB_HOST}:${env.DOCDB_PORT}/${env.DOCDB_DATABASE}?tls=false`,
    );
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
