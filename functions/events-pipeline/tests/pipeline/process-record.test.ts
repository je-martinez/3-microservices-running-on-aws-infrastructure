import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermanentError, TransientError } from "#pipeline/errors";
import type { EventDocument } from "#domain/event";
import type { Envelope } from "#domain/envelope";

// #pipeline/process-record logs its status transitions, and the real
// #shared/logging/app-logger reaches #shared/config/env, which Zod-parses
// process.env at MODULE LOAD (ADR-0014) and throws without the full DOCDB/SES
// set. This file tests a PURE function over an injected repository and has no
// business needing a database configuration to import — so the logger is
// redirected to an array here instead of stubbing five unrelated env vars.
//
// The real `buildLoggerOptions` is kept: the assertions below check what is
// actually serialized (in particular that the payload never reaches a line), so
// the production formatter has to be the one under test. The level is left at
// pino's DEFAULT (`info`) on purpose: the status lines must survive an
// unconfigured logger, which is exactly what they failed to do in the deployed
// Lambda. Lowering it to "debug" here would make these tests pass whether the
// lines are INFO or DEBUG.
const { rawLines } = vi.hoisted(() => ({ rawLines: [] as string[] }));

vi.mock("#shared/logging/app-logger", async () => {
  const { buildLoggerOptions } =
    await vi.importActual<typeof import("#shared/logging/logger")>("#shared/logging/logger");
  const { default: pinoActual } = await vi.importActual<typeof import("pino")>("pino");
  return {
    appLogger: pinoActual(
      {
        ...buildLoggerOptions({ serviceName: "events-pipeline", environment: "test" }),
      },
      { write: (s: string) => rawLines.push(s) },
    ),
  };
});

const { processRecord } = await import("#pipeline/process-record");
type EventsRepositoryPort = import("#pipeline/process-record").EventsRepositoryPort;
type HandlerMap = import("#pipeline/process-record").HandlerMap;

beforeEach(() => {
  rawLines.length = 0;
});

function emitted(): Record<string, unknown>[] {
  return rawLines.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    event_id: "evt_test1",
    type: "USER_CREATED",
    source: "users",
    user_id: "usr_test1",
    order_id: null,
    author: { actor: "users_api:register", user_id: "usr_test1", cognito_sub: "sub-test1" },
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
    // Second argument is HandlerDeps, and it is `{}` here because this caller
    // passed no handlerDeps — the production shape. A handler must never need
    // fixture wiring to run.
    expect(handler).toHaveBeenCalledWith(envelope, {});
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

  it("persists the producer's event_id verbatim — the pipeline mints no id of its own", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = { USER_CREATED: vi.fn(async () => {}) };

    await processRecord(makeEnvelope({ event_id: "producer-key-1" }), { repository, handlers });
    await processRecord(makeEnvelope({ event_id: "producer-key-2" }), { repository, handlers });

    const [first, second] = repository.inserted;
    expect(first?.event_id).toBe("producer-key-1");
    expect(second?.event_id).toBe("producer-key-2");
  });

  it("copies the envelope onto the persisted document and stamps audit fields", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = { ORDER_CREATED: vi.fn(async () => {}) };
    const envelope = makeEnvelope({
      type: "ORDER_CREATED",
      source: "orders",
      order_id: "ord_test1",
      author: { actor: "orders_api:create_order", user_id: "usr_test1" },
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
    // The audit split: created_by = what ORIGINATED the event (the producer's
    // semantic actor), updated_by = what PROCESSED it (this pipeline).
    expect(doc.created_by).toBe("orders_api:create_order");
    expect(doc.updated_by).toBe("events-pipeline");
    expect(doc.created_at).toBeInstanceOf(Date);
    expect(doc.updated_at).toBeInstanceOf(Date);
    expect(doc.deleted_by).toBeNull();
    expect(doc.deleted_at).toBeNull();
    // Required by docs/shared/conventions/audit-fields.md — a newly created
    // event is not deleted.
    expect(doc.is_deleted).toBe(false);
  });

  it("stamps created_by from the envelope's author, NOT the pipeline actor", async () => {
    // The carrier webhook: no human originated it, and its actor says so. The
    // previous behaviour stamped "events-pipeline" here, which recorded what
    // WROTE the row rather than what CAUSED it — indistinguishable from a
    // human-driven change.
    const repository = makeRepository();
    const handlers: HandlerMap = { TRACKING_STATUS_CHANGED: vi.fn(async () => {}) };

    await processRecord(
      makeEnvelope({
        type: "TRACKING_STATUS_CHANGED",
        source: "tracking",
        author: { actor: "tracking_api:carrier_status_update" },
      }),
      { repository, handlers },
    );

    expect(repository.inserted[0]?.created_by).toBe("tracking_api:carrier_status_update");
  });

  it("keeps updated_by as the pipeline actor — it is what PROCESSES the event", async () => {
    // The split is the point: overwriting updated_by with the author too would
    // lose which side performed the STARTED -> IN_PROGRESS -> COMPLETED writes.
    const repository = makeRepository();
    const handlers: HandlerMap = { USER_CREATED: vi.fn(async () => {}) };

    await processRecord(
      makeEnvelope({ author: { actor: "users_api:register", user_id: "usr_author" } }),
      { repository, handlers },
    );

    const doc = repository.inserted[0]!;
    expect(doc.updated_by).toBe("events-pipeline");
    expect(doc.created_by).toBe("users_api:register");
    expect(doc.created_by).not.toBe(doc.updated_by);
  });

  it("does not copy the author's ids onto the document's own user_id", async () => {
    // `user_id` on the document is the event's SUBJECT. An author acting on
    // someone else's behalf must not silently rewrite it.
    const repository = makeRepository();
    const handlers: HandlerMap = { USER_CREATED: vi.fn(async () => {}) };

    await processRecord(
      makeEnvelope({
        user_id: "usr_subject",
        author: { actor: "users_api:update_profile", user_id: "usr_author" },
      }),
      { repository, handlers },
    );

    expect(repository.inserted[0]?.user_id).toBe("usr_subject");
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

  it("persists AUTH_OTP_REQUESTED with the code redacted, but hands the handler the real code", async () => {
    // The two halves are one test on purpose: proving the persisted document is
    // clean is worthless if the handler was starved of the code too (the email
    // would go out blank and the assertion would still be green).
    const repository = makeRepository();
    let handlerSawCode: unknown;
    const handlers: HandlerMap = {
      AUTH_OTP_REQUESTED: vi.fn(async (envelope: Envelope) => {
        handlerSawCode = (envelope.payload as { code: unknown }).code;
      }),
    };
    const envelope = makeEnvelope({
      type: "AUTH_OTP_REQUESTED",
      payload: { email: "user@example.com", code: "042817", ttlSeconds: 300 },
    });

    const result = await processRecord(envelope, { repository, handlers });

    expect(result).toEqual({ ok: true });
    const doc = repository.inserted[0]!;
    expect(doc.payload).not.toHaveProperty("code");
    expect(doc.payload.email).toBe("user@example.com");
    expect(doc.payload.ttlSeconds).toBe(300);
    // Off the SERIALIZED document, not just the payload's own keys: this is
    // what catches the code surviving in a nested field or in some other
    // column the state machine copies it into.
    expect(JSON.stringify(doc)).not.toContain("042817");
    // ...and the handler still got the real thing.
    expect(handlerSawCode).toBe("042817");
  });

  it("does not redact the envelope the caller passed in", async () => {
    // redactPayload is pure and copies; a mutating implementation would empty
    // the caller's own object, which is the same object src/handler.ts hands to
    // the handler.
    const repository = makeRepository();
    const handlers: HandlerMap = { AUTH_OTP_REQUESTED: vi.fn(async () => {}) };
    const envelope = makeEnvelope({
      type: "AUTH_OTP_REQUESTED",
      payload: { email: "user@example.com", code: "042817", ttlSeconds: 300 },
    });

    await processRecord(envelope, { repository, handlers });

    expect(envelope.payload.code).toBe("042817");
  });

  it("persists every other type's payload verbatim — redaction is not a blanket filter", async () => {
    // The audit trail is the default; AUTH_OTP_REQUESTED is the one exception.
    const repository = makeRepository();
    const handlers: HandlerMap = { ORDER_CREATED: vi.fn(async () => {}) };
    const payload = { code: "PROMO2026", total: 42 };

    await processRecord(makeEnvelope({ type: "ORDER_CREATED", payload }), {
      repository,
      handlers,
    });

    expect(repository.inserted[0]?.payload).toEqual(payload);
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

describe("processRecord — status logging", () => {
  it("logs each transition at INFO with event_status, not status", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = { USER_CREATED: vi.fn(async () => {}) };

    await processRecord(makeEnvelope(), { repository, handlers });

    const statusLines = emitted().filter((l) => l.app_event === "event_status_changed");
    expect(statusLines.map((l) => l.event_status)).toEqual([
      "STARTED",
      "IN_PROGRESS",
      "COMPLETED",
    ]);
    // INFO, not DEBUG: at DEBUG these emitted ZERO times in the deployed Lambda
    // (LOG_LEVEL is unset, so pino sits at info), which made the transitions
    // invisible in production — the only place the question is asked.
    expect(statusLines.every((l) => l.severity_text === "INFO")).toBe(true);
    // `status` would collide with the HTTP status the other services log under
    // that name, so the field must NOT be called that.
    expect(statusLines.every((l) => !("status" in l))).toBe(true);
  });

  it("logs FAILED, not COMPLETED, when the handler throws", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = {
      USER_CREATED: vi.fn(async () => {
        throw new PermanentError("unprocessable payload");
      }),
    };

    await processRecord(makeEnvelope(), { repository, handlers });

    const statusLines = emitted().filter((l) => l.app_event === "event_status_changed");
    expect(statusLines.map((l) => l.event_status)).toEqual([
      "STARTED",
      "IN_PROGRESS",
      "FAILED",
    ]);
    // A failure line without a motive forces a join against another line before
    // it says anything, so FAILED carries the reason it persisted.
    expect(statusLines.at(-1)?.reason).toBe("unprocessable payload");
    expect(statusLines.at(-1)?.severity_text).toBe("INFO");
    // ...and ONLY failures carry it: a `reason` on COMPLETED would be noise.
    expect(statusLines.slice(0, 2).every((l) => !("reason" in l))).toBe(true);
  });

  it("carries the reason on the FAILED line for an unknown event type", async () => {
    // The other FAILED path — dispatch refuses the event before any handler
    // runs, so the reason is synthesized here rather than thrown.
    const repository = makeRepository();

    await processRecord(makeEnvelope({ type: "NOPE" }), { repository, handlers: {} });

    const statusLines = emitted().filter((l) => l.app_event === "event_status_changed");
    expect(statusLines.map((l) => l.event_status)).toEqual(["STARTED", "FAILED"]);
    expect(statusLines.at(-1)?.reason).toBe("Unknown event type");
    // The same string the document is stamped with — one fact, not two that can
    // drift apart.
    const failed = repository.calls.find(
      (c) => (c as unknown[])[0] === "transition" && (c as unknown[])[2] === "FAILED",
    ) as unknown[] | undefined;
    expect((failed?.[3] as { error?: string })?.error).toBe(statusLines.at(-1)?.reason);
  });

  it("logs no transition past STARTED when the insert itself fails", async () => {
    const repository = makeRepository();
    repository.insertStarted = vi.fn(async () => {
      throw new TransientError("DocumentDB unreachable");
    });

    await processRecord(makeEnvelope(), { repository, handlers: {} });

    // Nothing was persisted, so nothing may claim a status — not even STARTED,
    // which is logged only AFTER a successful insert.
    expect(emitted().filter((l) => l.app_event === "event_status_changed")).toEqual([]);
  });

  it("NEVER puts the payload in a log line, though it holds the whole document", async () => {
    // The real leak path: processRecord builds `doc` with the payload inside it
    // and then logs three times with that object in scope. A line spreading the
    // document (or logging `doc`) would carry the address straight into
    // CloudWatch. The payload is given a value that could only come from it.
    const repository = makeRepository();
    const handlers: HandlerMap = { USER_CREATED: vi.fn(async () => {}) };
    const envelope = makeEnvelope({
      payload: { id: "usr_test1", email: "leak@example.com", password: "hunter2" },
    });

    await processRecord(envelope, { repository, handlers });

    const serialized = rawLines.join("\n");
    expect(serialized).not.toContain("leak@example.com");
    expect(serialized).not.toContain("hunter2");
    // The document itself still carries it — only the LOG is clean, so this is
    // not passing merely because the payload went missing everywhere.
    expect(repository.inserted[0]?.payload).toMatchObject({ email: "leak@example.com" });
  });

  it("the FAILED reason is the handler's message verbatim — which the handlers keep PII-free", async () => {
    // This test pins a CONTRACT, not an implementation detail. `reason` is the
    // string the handler threw, and it is also what src/handler.ts already logs
    // as `event_processing_failed.reason` and what the document persists — one
    // fact in three places, which only stays safe because every handler builds
    // that message from FIELD PATHS and ERROR NAMES, never from the input (see
    // the comments in #handlers/user-created and #handlers/auth-otp-requested,
    // and `observe()` in src/handler.ts, which reduces a Mongo error to
    // `err.name` precisely because the driver's message embeds the rejected
    // document).
    //
    // So the leak this file can still catch is the one processRecord itself
    // owns: it holds the whole document, payload included, and must not put any
    // of it on a line by its own hand.
    const repository = makeRepository();
    const handlers: HandlerMap = {
      USER_CREATED: vi.fn(async () => {
        throw new PermanentError("invalid USER_CREATED payload: invalid fields: email");
      }),
    };

    await processRecord(
      makeEnvelope({ payload: { id: "usr_test1", email: "leak@example.com" } }),
      { repository, handlers },
    );

    const failedLine = emitted()
      .filter((l) => l.app_event === "event_status_changed")
      .at(-1);
    expect(failedLine?.event_status).toBe("FAILED");
    expect(failedLine?.reason).toBe("invalid USER_CREATED payload: invalid fields: email");
    // The payload was in scope the whole time and still reached no line.
    expect(rawLines.join("\n")).not.toContain("leak@example.com");
  });
});
