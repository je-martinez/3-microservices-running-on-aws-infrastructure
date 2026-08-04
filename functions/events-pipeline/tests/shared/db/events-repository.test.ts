import { describe, it, expect } from "vitest";
import type { Db } from "mongodb";
import { MongoEventsRepository, DuplicateEventError } from "#shared/db/events-repository";
import { PermanentError, isTransient } from "#pipeline/errors";
import type { EventDocument } from "#domain/event";

// Layer 1 — pure error-translation logic, no driver involved. The PERSISTENCE
// behaviour (unique index, $push) is deliberately NOT covered here: mocked
// persistence hides real schema/driver bugs, so it lives in the sibling
// .integration.test.ts against a real mongo:7.0. What is covered here is the
// adapter's own decision-making, which a real Mongo cannot exercise
// deterministically for every branch (e.g. a non-11000 driver error).

function makeDoc(overrides: Partial<EventDocument> = {}): EventDocument {
  const now = new Date();
  return {
    friendlyId: "evt_unit1",
    event_id: "evt_producer_unit1",
    order_id: null,
    user_id: "usr_unit1",
    type: "USER_CREATED",
    source: "users",
    payload: {},
    status: "STARTED",
    error: null,
    status_history: [{ status: "STARTED", timestamp: now }],
    createdBy: "events-pipeline",
    createdAt: now,
    updatedBy: "events-pipeline",
    updatedAt: now,
    deletedBy: null,
    deletedAt: null,
    isDeleted: false,
    ...overrides,
  };
}

// Minimal stand-in for the two driver calls the repository makes. Only used to
// drive error branches and to capture the update document's shape.
function fakeDb(behaviour: {
  insertOne?: () => Promise<unknown>;
  onUpdate?: (filter: unknown, update: unknown) => void;
}): Db {
  return {
    collection: () => ({
      insertOne: behaviour.insertOne ?? (async () => ({})),
      updateOne: async (filter: unknown, update: unknown) => {
        behaviour.onUpdate?.(filter, update);
        return {};
      },
    }),
  } as unknown as Db;
}

describe("MongoEventsRepository — duplicate-key translation", () => {
  it("translates Mongo error code 11000 into a PermanentError", async () => {
    const dupKeyError = Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    const repo = new MongoEventsRepository(
      fakeDb({
        insertOne: async () => {
          throw dupKeyError;
        },
      }),
    );

    await expect(repo.insertStarted(makeDoc())).rejects.toBeInstanceOf(PermanentError);
  });

  it("classifies the duplicate-key failure as NON-transient, so SQS consumes the redelivery", async () => {
    // This is the load-bearing assertion: isTransient() defaults to true for
    // anything unclassified, which would send an already-processed message back
    // to SQS until it reached the DLQ.
    const dupKeyError = Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    const repo = new MongoEventsRepository(
      fakeDb({
        insertOne: async () => {
          throw dupKeyError;
        },
      }),
    );

    const caught = await repo.insertStarted(makeDoc()).catch((err: unknown) => err);

    expect(isTransient(caught)).toBe(false);
  });

  it("names the offending event_id in the DuplicateEventError so logs can identify the redelivery", async () => {
    const dupKeyError = Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    const repo = new MongoEventsRepository(
      fakeDb({
        insertOne: async () => {
          throw dupKeyError;
        },
      }),
    );

    const caught = await repo
      .insertStarted(makeDoc({ event_id: "evt_producer_dup" }))
      .catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(DuplicateEventError);
    expect((caught as DuplicateEventError).message).toContain("evt_producer_dup");
  });

  it("rethrows a non-duplicate driver error unchanged, so it stays transient and is retried", async () => {
    // A connection failure must NOT be swallowed into the permanent bucket:
    // losing an unprocessed event is strictly worse than retrying it.
    const connError = Object.assign(new Error("connection timed out"), { code: 89 });
    const repo = new MongoEventsRepository(
      fakeDb({
        insertOne: async () => {
          throw connError;
        },
      }),
    );

    const caught = await repo.insertStarted(makeDoc()).catch((err: unknown) => err);

    expect(caught).toBe(connError);
    expect(caught).not.toBeInstanceOf(PermanentError);
    expect(isTransient(caught)).toBe(true);
  });

  it("resolves normally when the insert succeeds", async () => {
    const repo = new MongoEventsRepository(fakeDb({}));
    await expect(repo.insertStarted(makeDoc())).resolves.toBeUndefined();
  });
});

describe("MongoEventsRepository — transition update shape", () => {
  it("targets the document by event_id", async () => {
    let seenFilter: unknown;
    const repo = new MongoEventsRepository(
      fakeDb({ onUpdate: (filter) => (seenFilter = filter) }),
    );

    await repo.transition("evt_producer_unit1", "IN_PROGRESS");

    expect(seenFilter).toEqual({ event_id: "evt_producer_unit1" });
  });

  it("omits `error` from $set and from the history entry when no patch is given", async () => {
    let seenUpdate: Record<string, Record<string, unknown>> | undefined;
    const repo = new MongoEventsRepository(
      fakeDb({
        onUpdate: (_filter, update) => {
          seenUpdate = update as Record<string, Record<string, unknown>>;
        },
      }),
    );

    await repo.transition("evt_producer_unit1", "COMPLETED");

    expect(seenUpdate?.$set).not.toHaveProperty("error");
    expect(seenUpdate?.$push.status_history).not.toHaveProperty("error");
  });

  it("includes `error` in both $set and the pushed history entry when patched", async () => {
    let seenUpdate: Record<string, Record<string, unknown>> | undefined;
    const repo = new MongoEventsRepository(
      fakeDb({
        onUpdate: (_filter, update) => {
          seenUpdate = update as Record<string, Record<string, unknown>>;
        },
      }),
    );

    await repo.transition("evt_producer_unit1", "FAILED", { error: "Unknown event type" });

    expect(seenUpdate?.$set.error).toBe("Unknown event type");
    expect(
      (seenUpdate?.$push.status_history as { error?: string }).error,
    ).toBe("Unknown event type");
  });

  it("stamps updatedAt/updatedBy on every transition (audit-fields convention)", async () => {
    let seenUpdate: Record<string, Record<string, unknown>> | undefined;
    const repo = new MongoEventsRepository(
      fakeDb({
        onUpdate: (_filter, update) => {
          seenUpdate = update as Record<string, Record<string, unknown>>;
        },
      }),
    );

    await repo.transition("evt_producer_unit1", "IN_PROGRESS");

    expect(seenUpdate?.$set.updatedBy).toBe("events-pipeline");
    expect(seenUpdate?.$set.updatedAt).toBeInstanceOf(Date);
  });

  it("appends via $push rather than replacing status_history via $set", async () => {
    let seenUpdate: Record<string, Record<string, unknown>> | undefined;
    const repo = new MongoEventsRepository(
      fakeDb({
        onUpdate: (_filter, update) => {
          seenUpdate = update as Record<string, Record<string, unknown>>;
        },
      }),
    );

    await repo.transition("evt_producer_unit1", "IN_PROGRESS");

    expect(seenUpdate?.$push).toHaveProperty("status_history");
    expect(seenUpdate?.$set).not.toHaveProperty("status_history");
  });
});
