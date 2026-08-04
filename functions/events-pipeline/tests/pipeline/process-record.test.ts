import { describe, it, expect, vi } from "vitest";
import { processRecord, type EventsRepositoryPort, type HandlerMap } from "#pipeline/process-record";
import { PermanentError, TransientError } from "#pipeline/errors";
import { EVENT_ID_PREFIX, type EventDocument } from "#domain/event";
import type { Envelope } from "#domain/envelope";

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    event_id: "evt_test1",
    type: "USER_CREATED",
    source: "users",
    user_id: "usr_test1",
    order_id: null,
    payload: { id: "usr_test1", email: "test@example.com" },
    ...overrides,
  };
}

function makeRepository(): EventsRepositoryPort & { calls: unknown[]; inserted: EventDocument[] } {
  const calls: unknown[] = [];
  const inserted: EventDocument[] = [];
  return {
    calls,
    inserted,
    insertStarted: vi.fn(async (doc: EventDocument) => {
      inserted.push(doc);
      calls.push(["insertStarted", doc]);
    }),
    transition: vi.fn(async (event_id: string, status: string, patch?: { error?: string }) => {
      calls.push(["transition", event_id, status, patch]);
    }),
  };
}

describe("processRecord", () => {
  it("STARTED -> IN_PROGRESS -> COMPLETED on a successful handler", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = { USER_CREATED: vi.fn(async () => {}) };
    const envelope = makeEnvelope();

    const result = await processRecord(envelope, { repository, handlers });

    expect(result).toEqual({ ok: true });
    expect(repository.insertStarted).toHaveBeenCalledOnce();
    expect(repository.inserted[0]?.status).toBe("STARTED");
    // Called with two arguments — no `patch` on a non-failing transition.
    expect(repository.transition).toHaveBeenNthCalledWith(1, "evt_test1", "IN_PROGRESS");
    expect(repository.transition).toHaveBeenNthCalledWith(2, "evt_test1", "COMPLETED");
    expect(repository.transition).toHaveBeenCalledTimes(2);
  });

  it("invokes the handler with the envelope, exactly once", async () => {
    const repository = makeRepository();
    const handler = vi.fn(async () => {});
    const handlers: HandlerMap = { USER_CREATED: handler };
    const envelope = makeEnvelope();

    await processRecord(envelope, { repository, handlers });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(envelope);
  });

  it("unknown type -> FAILED with 'Unknown event type', handler never invoked", async () => {
    const repository = makeRepository();
    const handler = vi.fn(async () => {});
    const handlers: HandlerMap = { USER_CREATED: handler };
    const envelope = makeEnvelope({ type: "SOMETHING_ELSE" });

    const result = await processRecord(envelope, { repository, handlers });

    expect(result).toEqual({ ok: false, transient: false });
    expect(handler).not.toHaveBeenCalled();
    expect(repository.transition).toHaveBeenCalledWith("evt_test1", "FAILED", {
      error: "Unknown event type",
    });
    // Never reaches IN_PROGRESS: FAILED is the only transition.
    expect(repository.transition).toHaveBeenCalledTimes(1);
  });

  it("does not resolve handlers through the prototype chain", async () => {
    const repository = makeRepository();
    // "constructor" / "toString" exist on Object.prototype. A naive
    // `handlers[type]` lookup would find one and try to call it.
    const envelope = makeEnvelope({ type: "toString" });

    const result = await processRecord(envelope, { repository, handlers: {} });

    expect(result).toEqual({ ok: false, transient: false });
    expect(repository.transition).toHaveBeenCalledWith("evt_test1", "FAILED", {
      error: "Unknown event type",
    });
  });

  it("PermanentError from a handler -> FAILED, not transient", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = {
      USER_CREATED: vi.fn(async () => {
        throw new PermanentError("invalid payload");
      }),
    };

    const result = await processRecord(makeEnvelope(), { repository, handlers });

    expect(result).toEqual({ ok: false, transient: false });
    expect(repository.transition).toHaveBeenCalledWith("evt_test1", "FAILED", {
      error: "invalid payload",
    });
  });

  it("TransientError from a handler -> FAILED persisted, but reported transient", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = {
      USER_CREATED: vi.fn(async () => {
        throw new TransientError("SES unreachable");
      }),
    };

    const result = await processRecord(makeEnvelope(), { repository, handlers });

    expect(result).toEqual({ ok: false, transient: true });
    expect(repository.transition).toHaveBeenCalledWith("evt_test1", "FAILED", {
      error: "SES unreachable",
    });
  });

  it("an unclassified thrown error is treated as transient", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = {
      USER_CREATED: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    const result = await processRecord(makeEnvelope(), { repository, handlers });

    expect(result).toEqual({ ok: false, transient: true });
  });

  it("a non-Error thrown value is stringified into the FAILED error", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = {
      USER_CREATED: vi.fn(async () => {
        throw "a string was thrown";
      }),
    };

    const result = await processRecord(makeEnvelope(), { repository, handlers });

    expect(result).toEqual({ ok: false, transient: true });
    expect(repository.transition).toHaveBeenCalledWith("evt_test1", "FAILED", {
      error: "a string was thrown",
    });
  });

  it("persists the document BEFORE dispatch (insertStarted precedes transition)", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = { USER_CREATED: vi.fn(async () => {}) };

    await processRecord(makeEnvelope(), { repository, handlers });

    const kinds = repository.calls.map((c) => (c as unknown[])[0]);
    expect(kinds[0]).toBe("insertStarted");
  });

  it("persists the document BEFORE dispatch even when the type is unknown", async () => {
    const repository = makeRepository();

    await processRecord(makeEnvelope({ type: "SOMETHING_ELSE" }), {
      repository,
      handlers: {},
    });

    // The audit trail must capture failures too — an unknown type is still
    // recorded rather than vanishing.
    expect(repository.insertStarted).toHaveBeenCalledOnce();
    const kinds = repository.calls.map((c) => (c as unknown[])[0]);
    expect(kinds).toEqual(["insertStarted", "transition"]);
  });

  it("stamps an evt_-prefixed friendlyId distinct from the producer's event_id", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = { USER_CREATED: vi.fn(async () => {}) };

    await processRecord(makeEnvelope({ event_id: "producer-key-1" }), { repository, handlers });
    await processRecord(makeEnvelope({ event_id: "producer-key-2" }), { repository, handlers });

    const [first, second] = repository.inserted;
    expect(first?.friendlyId.startsWith(EVENT_ID_PREFIX)).toBe(true);
    expect(first?.friendlyId.length).toBeGreaterThan(EVENT_ID_PREFIX.length);
    // friendlyId is the pipeline's own display id, NOT the producer's key.
    expect(first?.friendlyId).not.toBe("producer-key-1");
    expect(first?.event_id).toBe("producer-key-1");
    // Freshly generated per record, not a constant.
    expect(first?.friendlyId).not.toBe(second?.friendlyId);
  });

  it("copies the envelope onto the persisted document and stamps audit fields", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = { ORDER_CREATED: vi.fn(async () => {}) };
    const envelope = makeEnvelope({
      type: "ORDER_CREATED",
      source: "orders",
      order_id: "ord_test1",
      payload: { total: 42 },
    });

    await processRecord(envelope, { repository, handlers });

    const doc = repository.inserted[0]!;
    expect(doc.event_id).toBe(envelope.event_id);
    expect(doc.type).toBe("ORDER_CREATED");
    expect(doc.source).toBe("orders");
    expect(doc.order_id).toBe("ord_test1");
    expect(doc.user_id).toBe("usr_test1");
    expect(doc.payload).toEqual({ total: 42 });
    expect(doc.error).toBeNull();
    expect(doc.createdBy).toBe("events-pipeline");
    expect(doc.updatedBy).toBe("events-pipeline");
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
    expect(doc.deletedBy).toBeNull();
    expect(doc.deletedAt).toBeNull();
    // Required by docs/shared/conventions/audit-fields.md — a newly created
    // event is not deleted.
    expect(doc.isDeleted).toBe(false);
  });

  it("seeds status_history with the STARTED entry", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = { USER_CREATED: vi.fn(async () => {}) };

    await processRecord(makeEnvelope(), { repository, handlers });

    const doc = repository.inserted[0]!;
    expect(doc.status_history).toHaveLength(1);
    expect(doc.status_history[0]?.status).toBe("STARTED");
    expect(doc.status_history[0]?.timestamp).toBeInstanceOf(Date);
  });

  it("never mutates or replaces status_history after insert — transitions append via the repository", async () => {
    // The append-only guarantee lives in the transition contract: the state
    // machine hands the repository (status, patch) pairs and NEVER reaches back
    // into the inserted document's array. If someone replaced the array (or
    // pushed into it here instead of delegating), this test catches it: the
    // inserted document still holds exactly its seed entry, and every later
    // status arrives as its own transition call, in order.
    const repository = makeRepository();
    const handlers: HandlerMap = { USER_CREATED: vi.fn(async () => {}) };

    await processRecord(makeEnvelope(), { repository, handlers });

    const doc = repository.inserted[0]!;
    const seed = doc.status_history[0];
    expect(doc.status_history).toHaveLength(1);
    expect(seed?.status).toBe("STARTED");

    const statuses = repository.calls
      .filter((c) => (c as unknown[])[0] === "transition")
      .map((c) => (c as unknown[])[2]);
    expect(statuses).toEqual(["IN_PROGRESS", "COMPLETED"]);
  });

  it("records the full FAILED path in order: STARTED seed, then IN_PROGRESS, then FAILED", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = {
      USER_CREATED: vi.fn(async () => {
        throw new PermanentError("nope");
      }),
    };

    await processRecord(makeEnvelope(), { repository, handlers });

    expect(repository.inserted[0]?.status).toBe("STARTED");
    const statuses = repository.calls
      .filter((c) => (c as unknown[])[0] === "transition")
      .map((c) => (c as unknown[])[2]);
    expect(statuses).toEqual(["IN_PROGRESS", "FAILED"]);
  });

  it("reports transient when insertStarted itself fails (nothing was persisted)", async () => {
    const repository = makeRepository();
    repository.insertStarted = vi.fn(async () => {
      throw new TransientError("DocumentDB unreachable");
    });
    const handler = vi.fn(async () => {});
    const handlers: HandlerMap = { USER_CREATED: handler };

    const result = await processRecord(makeEnvelope(), { repository, handlers });

    expect(result).toEqual({ ok: false, transient: true });
    expect(handler).not.toHaveBeenCalled();
  });
});
