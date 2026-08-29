import type { Db } from "mongodb";
import { env } from "#shared/config/env";
import { E2E_EMAILS_COLLECTION, EmailRecordSchema, type EmailRecord } from "#e2e/email-record";

// The caller supplies the facts; the store owns the clock.
export type EmailRecordInput = Omit<EmailRecord, "created_at" | "expires_at">;

export type EmailQuery = {
  runId: string;
  to?: string;
  templateKey?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 50;

// A hard ceiling, not a default. Without it a caller could ask for the whole
// collection and stream it through a Lambda response body.
const MAX_LIMIT = 200;

// `expireAfterSeconds: 0` is the per-document form: MongoDB deletes the row at
// the instant named by the indexed DATE FIELD, rather than N seconds after it.
// That is what lets each record carry its own lifetime, and it is why
// expires_at is computed at write time instead of being a fixed collection
// policy.
//
// This runs ONLY under E2E_TESTING_ENABLED (see the caller in src/handler.ts):
// a deployed environment creates neither index nor collection.
export async function ensureE2eIndexes(db: Db): Promise<void> {
  const collection = db.collection(E2E_EMAILS_COLLECTION);
  await collection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  // The exact shape the HTTP query filters on. Compound and ordered: run_id
  // first because every query is scoped by it.
  await collection.createIndex({ run_id: 1, to: 1 });
}

export class E2eEmailStore {
  constructor(private readonly db: Db) {}

  async record(input: EmailRecordInput): Promise<void> {
    const createdAt = new Date();
    // Parsed rather than trusted, even though the only caller is our own
    // handler: a malformed document here fails at QUERY time, inside a test,
    // far from the code that wrote it.
    const doc = EmailRecordSchema.parse({
      ...input,
      created_at: createdAt,
      expires_at: new Date(createdAt.getTime() + env.E2E_EMAIL_TTL_SECONDS * 1000),
    });
    await this.db.collection(E2E_EMAILS_COLLECTION).insertOne(doc);
  }

  async query(filter: EmailQuery): Promise<EmailRecord[]> {
    // run_id is unconditional. Workers and reruns share this collection, so an
    // unscoped query would hand a spec another run's mail and pass for the
    // wrong reason.
    const mongoFilter: Record<string, string> = { run_id: filter.runId };
    if (filter.to) mongoFilter.to = filter.to;
    if (filter.templateKey) mongoFilter.template_key = filter.templateKey;

    const capped = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    return (await this.db
      .collection(E2E_EMAILS_COLLECTION)
      .find(mongoFilter)
      .sort({ created_at: -1 })
      .limit(capped)
      .toArray()) as unknown as EmailRecord[];
  }
}
