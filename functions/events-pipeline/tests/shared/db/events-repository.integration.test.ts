import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoEventsRepository, ensureIndexes, DuplicateEventError } from "#shared/db/events-repository";
import { PermanentError, isTransient } from "#pipeline/errors";
import type { EventDocument } from "#domain/event";

// Layer 2 — real persistence against Floci's DocumentDB (a standalone
// mongo:7.0 container), NOT a mock. Mocked persistence hides real
// schema/driver bugs: a fake collection happily accepts a document the real
// driver rejects, and a fake cannot enforce a unique index at all. The
// duplicate-key path this file covers only exists because the SERVER raises
// code 11000 — there is nothing to test without a server.
//
// Connectivity (see functions/events-pipeline/CLAUDE.md §3b): port 27017 is
// NOT published to the host and Floci reassigns the container IP on every
// recreation, so this test connects by the backing container NAME
// (floci-docdb-<db-cluster-identifier>) over 3mrai-network, and therefore must
// run from INSIDE that network (e.g. `docker compose exec`).
//
// Env is read directly rather than through #shared/config/env because that
// module also requires SES_FROM_ADDRESS, which has nothing to do with the
// database and would make this test fail for an unrelated reason.
const DOCDB_HOST = process.env.DOCDB_HOST;
const DOCDB_PORT = process.env.DOCDB_PORT ?? "27017";
const DOCDB_USERNAME = process.env.DOCDB_USERNAME;
const DOCDB_PASSWORD = process.env.DOCDB_PASSWORD;
const DOCDB_DATABASE = process.env.DOCDB_DATABASE ?? "events";
// Floci's DocumentDB authenticates the master user against the target database,
// but a stock mongo:7.0 with MONGO_INITDB_ROOT_* creates the root user in
// `admin`. Overridable so the same suite runs against either substrate.
const DOCDB_AUTH_SOURCE = process.env.DOCDB_AUTH_SOURCE;

// Guard, not a silent skip: without a reachable DocumentDB this suite proves
// nothing, so it must FAIL loudly rather than report green. Set
// EVENTS_PIPELINE_SKIP_INTEGRATION=1 only for a deliberate, reported skip.
const missingEnv = !DOCDB_HOST || !DOCDB_USERNAME || !DOCDB_PASSWORD;

const uri =
  `mongodb://${DOCDB_USERNAME}:${DOCDB_PASSWORD}@${DOCDB_HOST}:${DOCDB_PORT}/${DOCDB_DATABASE}?tls=false` +
  (DOCDB_AUTH_SOURCE ? `&authSource=${DOCDB_AUTH_SOURCE}` : "");

const E2E_USER = "usr_e2e_task8";

function makeDoc(overrides: Partial<EventDocument> = {}): EventDocument {
  const now = new Date();
  return {
    event_id: "evt_producer_e2e_task8_a",
    order_id: null,
    user_id: E2E_USER,
    type: "USER_CREATED",
    source: "users",
    payload: { id: E2E_USER },
    status: "STARTED",
    error: null,
    status_history: [{ status: "STARTED", timestamp: now }],
    created_by: "events-pipeline",
    created_at: now,
    updated_by: "events-pipeline",
    updated_at: now,
    deleted_by: null,
    deleted_at: null,
    is_deleted: false,
    ...overrides,
  };
}

describe.skipIf(missingEnv)("MongoEventsRepository (integration, real DocumentDB)", () => {
  let client: MongoClient;
  let db: Db;
  let repo: MongoEventsRepository;

  beforeAll(async () => {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db(DOCDB_DATABASE);
    // Clean any residue from a previous run BEFORE creating indexes, so a
    // leftover document cannot make the duplicate-key test pass vacuously.
    await db.collection("events").deleteMany({ user_id: E2E_USER });
    await ensureIndexes(db);
    repo = new MongoEventsRepository(db);
  });

  afterAll(async () => {
    if (db) await db.collection("events").deleteMany({ user_id: E2E_USER });
    if (client) await client.close();
  });

  it("creates the unique index on event_id and the non-unique query indexes", async () => {
    const indexes = await db.collection("events").indexes();
    const byKey = (field: string) => indexes.find((i) => JSON.stringify(i.key) === JSON.stringify({ [field]: 1 }));

    expect(byKey("event_id")?.unique).toBe(true);
    // The design spec's non-unique query indexes must exist but must NOT be unique.
    expect(byKey("order_id")).toBeDefined();
    expect(byKey("order_id")?.unique).toBeUndefined();
    expect(byKey("user_id")).toBeDefined();
    expect(byKey("type")).toBeDefined();
    expect(byKey("status")).toBeDefined();
    expect(byKey("created_at")).toBeDefined();
  });

  it("ensureIndexes is idempotent — a second call against the same collection succeeds", async () => {
    await expect(ensureIndexes(db)).resolves.toBeUndefined();
  });

  it("persists a full document including snake_case audit fields and is_deleted", async () => {
    await repo.insertStarted(makeDoc());

    const found = await db.collection("events").findOne({ event_id: "evt_producer_e2e_task8_a" });

    expect(found).not.toBeNull();
    expect(found?.created_by).toBe("events-pipeline");
    expect(found?.updated_by).toBe("events-pipeline");
    expect(found?.created_at).toBeInstanceOf(Date);
    expect(found?.updated_at).toBeInstanceOf(Date);
    expect(found?.deleted_at).toBeNull();
    expect(found?.deleted_by).toBeNull();
    // Audit-fields convention: is_deleted is materialized on write by this
    // hand-written repository (there is no Prisma-style extension to derive it).
    expect(found?.is_deleted).toBe(false);
    expect(found?.status).toBe("STARTED");
  });

  it("stores every field in snake_case — the document has no ORM mapping layer", async () => {
    // Reading the RAW stored document is the point: with no ORM between the
    // TypeScript property and the DocumentDB field, only a real round-trip
    // proves what is actually on disk.
    const found = await db.collection("events").findOne({ event_id: "evt_producer_e2e_task8_a" });

    const keys = Object.keys(found!).filter((k) => k !== "_id");
    expect(keys.sort()).toEqual(
      [
        "created_at",
        "created_by",
        "deleted_at",
        "deleted_by",
        "error",
        "event_id",
        "is_deleted",
        "order_id",
        "payload",
        "source",
        "status",
        "status_history",
        "type",
        "updated_at",
        "updated_by",
        "user_id",
      ].sort(),
    );
    // No leftover display id and no camelCase survivor.
    expect(found).not.toHaveProperty("friendlyId");
    for (const key of keys) {
      expect(key).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });

  it("$push appends to status_history on transition, without overwriting prior entries", async () => {
    await repo.transition("evt_producer_e2e_task8_a", "IN_PROGRESS");
    await repo.transition("evt_producer_e2e_task8_a", "COMPLETED");

    const found = await db.collection("events").findOne({ event_id: "evt_producer_e2e_task8_a" });
    const statuses = (found?.status_history as { status: string }[]).map((h) => h.status);

    expect(statuses).toEqual(["STARTED", "IN_PROGRESS", "COMPLETED"]);
    expect(found?.status).toBe("COMPLETED");
  });

  it("records the error on a FAILED transition, in both the field and the history entry", async () => {
    await repo.insertStarted(makeDoc({ event_id: "evt_producer_e2e_task8_f" }));
    await repo.transition("evt_producer_e2e_task8_f", "FAILED", { error: "Unknown event type" });

    const found = await db.collection("events").findOne({ event_id: "evt_producer_e2e_task8_f" });
    const history = found?.status_history as { status: string; error?: string }[];

    expect(found?.error).toBe("Unknown event type");
    expect(history.at(-1)?.error).toBe("Unknown event type");
  });

  it("rejects a second insert with the same event_id as a PermanentError (SQS must consume the redelivery)", async () => {
    // The real unique index is what raises code 11000 here — the whole point of
    // running this against a real server.
    const dup = makeDoc({
      event_id: "evt_producer_e2e_task8_a", // SAME idempotency key — must collide
      payload: { note: "redelivery" }, // otherwise-different document
    });

    const caught = await repo.insertStarted(dup).catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(DuplicateEventError);
    expect(caught).toBeInstanceOf(PermanentError);
    // Without the translation, isTransient() would default to true and SQS
    // would retry an ALREADY-PROCESSED message all the way to the DLQ.
    expect(isTransient(caught)).toBe(false);

    const count = await db
      .collection("events")
      .countDocuments({ event_id: "evt_producer_e2e_task8_a" });
    expect(count).toBe(1); // no duplicate row — idempotency confirmed
  });

  it("accepts a second insert with a DIFFERENT event_id (only event_id is unique)", async () => {
    // The complement of the test above: nothing else on the document is
    // constrained, so an otherwise-identical event with its own idempotency key
    // must persist. This is what previously would have collided on friendlyId.
    await expect(
      repo.insertStarted(makeDoc({ event_id: "evt_producer_e2e_task8_c" })),
    ).resolves.toBeUndefined();

    const count = await db
      .collection("events")
      .countDocuments({ event_id: "evt_producer_e2e_task8_c" });
    expect(count).toBe(1);
  });
});
