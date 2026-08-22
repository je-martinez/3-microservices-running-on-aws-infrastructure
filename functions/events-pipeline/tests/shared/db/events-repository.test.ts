import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "mongodb";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  mockTracingModule,
  pipelineTracer,
  resetTracingHarness,
  spanExporter,
} from "../../tracing-harness.ts";

// FILE-WIDE: the repository now opens a manual CLIENT span, so it imports the
// tracing module, which calls sdk.start() and opens a real OTLP exporter at
// import time. See tests/tracing-harness.ts.
mockTracingModule();

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
    event_id: "evt_producer_unit1",
    order_id: null,
    user_id: "usr_unit1",
    type: "USER_CREATED",
    source: "users",
    payload: {},
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

  it("stamps updated_at/updated_by on every transition (audit-fields convention)", async () => {
    let seenUpdate: Record<string, Record<string, unknown>> | undefined;
    const repo = new MongoEventsRepository(
      fakeDb({
        onUpdate: (_filter, update) => {
          seenUpdate = update as Record<string, Record<string, unknown>>;
        },
      }),
    );

    await repo.transition("evt_producer_unit1", "IN_PROGRESS");

    expect(seenUpdate?.$set.updated_by).toBe("events-pipeline");
    expect(seenUpdate?.$set.updated_at).toBeInstanceOf(Date);
    // Guard against camelCase drifting back in: there is no ORM mapping layer,
    // so the $set path IS the stored field name.
    expect(seenUpdate?.$set).not.toHaveProperty("updatedBy");
    expect(seenUpdate?.$set).not.toHaveProperty("updatedAt");
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


describe("MongoEventsRepository — the manual DocumentDB span", () => {
  beforeEach(() => resetTracingHarness());

  it("opens a CLIENT span named 'documentdb insertOne' as a CHILD of the active span", async () => {
    const repo = new MongoEventsRepository(fakeDb({}));

    // The parent stands in for `process_record`. Parentage comes from the
    // AMBIENT context — nothing is threaded into the repository — so this is
    // what proves the wrapper is wired into the context rather than emitting an
    // orphan span that merely reaches the exporter.
    let parentSpanId = "";
    await pipelineTracer.startActiveSpan("process_record", async (parent) => {
      parentSpanId = parent.spanContext().spanId;
      await repo.insertStarted(makeDoc());
      parent.end();
    });

    const dbSpan = spanExporter.getFinishedSpans().find((s) => s.name === "documentdb insertOne");
    expect(dbSpan).toBeDefined();
    expect(dbSpan!.kind).toBe(SpanKind.CLIENT);
    expect(dbSpan!.parentSpanContext?.spanId).toBe(parentSpanId);
    expect(dbSpan!.attributes["db.system"]).toBe("documentdb");
    expect(dbSpan!.attributes["db.operation"]).toBe("insertOne");
    expect(dbSpan!.status.code).toBe(SpanStatusCode.OK);
  });

  it("records the error CLASS, never the driver message, when the write fails", async () => {
    // A Mongo write error's message embeds the REJECTED DOCUMENT — the event
    // payload, carrying the user's email. The handler already reduces those to
    // err.name for that reason; Jaeger is not a lower-PII destination than
    // CloudWatch, so the span obeys the same rule.
    const driverError = Object.assign(
      new Error('E11000 duplicate key { payload: { email: "victim@example.com" } }'),
      { name: "MongoServerError" },
    );
    const repo = new MongoEventsRepository(
      fakeDb({
        insertOne: async () => {
          throw driverError;
        },
      }),
    );

    await expect(repo.insertStarted(makeDoc())).rejects.toThrow();

    const dbSpan = spanExporter.getFinishedSpans().find((s) => s.name === "documentdb insertOne");
    expect(dbSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(dbSpan!.status.message).toBe("MongoServerError");
    // Every field that actually travels to the collector, checked as one
    // string: attributes, status and events are the whole exportable surface of
    // a span.
    const exported = JSON.stringify({
      attributes: dbSpan!.attributes,
      status: dbSpan!.status,
      events: dbSpan!.events,
    });
    expect(exported).not.toContain("victim@example.com");
    expect(exported).not.toContain("E11000");
    // recordException would have stamped exception.message AND
    // exception.stacktrace onto the span, reopening the same leak.
    expect(dbSpan!.events).toHaveLength(0);
  });

  it("ends the span even when the insert throws", async () => {
    const repo = new MongoEventsRepository(
      fakeDb({
        insertOne: async () => {
          throw new Error("connection refused");
        },
      }),
    );

    await expect(repo.insertStarted(makeDoc())).rejects.toThrow();

    // Only an ENDED span reaches the exporter at all — an unclosed one does not
    // surface as an error, it silently vanishes from the trace.
    expect(spanExporter.getFinishedSpans().some((s) => s.name === "documentdb insertOne")).toBe(
      true,
    );
  });
});
