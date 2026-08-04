import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TransientError, PermanentError } from "#pipeline/errors";

// The DB layer is the only thing mocked here: this suite is about the
// entrypoint's own responsibilities (parsing raw SQS bodies, assembling
// batchItemFailures, one-time index bootstrap, logging). processRecord is NOT
// mocked — it is a pure function over the injected repository, so exercising
// the real one keeps this an integration of handler+state-machine rather than a
// test of the mock.
const insertStarted = vi.fn(async () => {});
const transition = vi.fn(async () => {});
const ensureIndexes = vi.fn(async () => {});
const getMongoClient = vi.fn(async () => ({ db: () => ({}) }));

// #shared/config/env parses process.env at MODULE LOAD (ADR-0014), so the
// values must exist before src/handler.ts is imported — hence the dynamic
// import below. Only DOCDB_DATABASE is actually read by the handler; the rest
// satisfy the schema.
vi.stubEnv("DOCDB_HOST", "docdb-test");
vi.stubEnv("DOCDB_USERNAME", "root");
vi.stubEnv("DOCDB_PASSWORD", "secret");
vi.stubEnv("DOCDB_DATABASE", "events");
vi.stubEnv("SES_FROM_ADDRESS", "noreply@example.com");

vi.mock("#shared/db/client", () => ({
  getMongoClient: (...args: unknown[]) => getMongoClient(...(args as [])),
}));
vi.mock("#shared/db/events-repository", async () => {
  // DuplicateEventError is re-exported from the real module: the handler
  // classifies on `instanceof`, and a stubbed class would silently never match.
  const actual = await vi.importActual<typeof import("#shared/db/events-repository")>(
    "#shared/db/events-repository",
  );
  return {
    ...actual,
    MongoEventsRepository: vi.fn(() => ({ insertStarted, transition })),
    ensureIndexes: (...args: unknown[]) => ensureIndexes(...(args as [])),
  };
});
// Pino writes to its DESTINATION, never through console, so the console spies
// this suite used before the pino migration would now capture nothing. The
// logger is redirected instead: same real `buildLoggerOptions` — the ALS context
// merge, the severity mapping and the `err` promotion are all the production
// ones — but writing into an array rather than stdout. Only the destination is
// faked, so the PII assertions below still exercise the real serialization path
// that a leak would travel through.
//
// `level: "debug"` so #pipeline/process-record's DEBUG status lines are captured
// too: they are below pino's default threshold, and a payload leak through one
// of them would otherwise be invisible to this suite.
const { rawLines } = vi.hoisted(() => ({ rawLines: [] as string[] }));

vi.mock("#shared/logging/app-logger", async () => {
  const { buildLoggerOptions: build } =
    await vi.importActual<typeof import("#shared/logging/logger")>("#shared/logging/logger");
  const { default: pinoActual } = await vi.importActual<typeof import("pino")>("pino");
  return {
    appLogger: pinoActual(
      { ...build({ serviceName: "events-pipeline", environment: "test" }), level: "debug" },
      { write: (s: string) => rawLines.push(s) },
    ),
  };
});

vi.mock("#handlers/index", () => ({
  handlers: {
    USER_CREATED: vi.fn(async () => {}),
    FLAKY: vi.fn(async () => {
      throw new TransientError("simulated outage");
    }),
    BROKEN: vi.fn(async () => {
      throw new PermanentError("unprocessable payload");
    }),
  },
}));

const { handler, resetIndexBootstrapForTests } = await import("../src/handler.ts");
const { DuplicateEventError } = await import("#shared/db/events-repository");

function sqsRecord(messageId: string, body: unknown) {
  return { messageId, body: JSON.stringify(body) };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_1",
    type: "USER_CREATED",
    source: "users",
    user_id: "usr_1",
    order_id: null,
    author: { actor: "users_api:register", user_id: "usr_1", cognito_sub: "sub-1" },
    payload: { id: "usr_1", email: "a@example.com" },
    ...overrides,
  };
}

type LogLine = Record<string, unknown>;

// Every emitted line, parsed. `level` is read from the record's own
// `severity_text` rather than from which console method was called: pino writes
// every severity to the SAME destination, so the severity only exists in the
// record. That is also the field an operator filters on, which makes these
// assertions test what production is actually queried by.
function emitted(): { level: string; line: LogLine }[] {
  return rawLines.map((raw) => {
    const line = JSON.parse(raw) as LogLine;
    return { level: String(line.severity_text ?? "").toLowerCase(), line };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetIndexBootstrapForTests();
  rawLines.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handler — batch item failures", () => {
  it("processes a good record and reports no batch item failures", async () => {
    const result = await handler({ Records: [sqsRecord("msg-1", envelope())] });

    expect(result.batchItemFailures).toEqual([]);
    expect(insertStarted).toHaveBeenCalledOnce();
  });

  it("assembles batchItemFailures for a transient failure, leaves the good message out", async () => {
    const result = await handler({
      Records: [
        sqsRecord("msg-good", envelope({ event_id: "evt_good" })),
        sqsRecord("msg-bad", envelope({ event_id: "evt_bad", type: "FLAKY" })),
      ],
    });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-bad" }]);
  });

  it("a permanent handler failure is CONSUMED, not retried", async () => {
    const result = await handler({
      Records: [sqsRecord("msg-perm", envelope({ type: "BROKEN" }))],
    });

    // The document is still persisted FAILED — but SQS must not redeliver it.
    expect(transition).toHaveBeenCalledWith("evt_1", "FAILED", {
      error: "unprocessable payload",
    });
    expect(result.batchItemFailures).toEqual([]);
  });

  it("an unknown event type is consumed, not retried", async () => {
    const result = await handler({
      Records: [sqsRecord("msg-unknown", envelope({ type: "NOBODY_HANDLES_THIS" }))],
    });

    expect(result.batchItemFailures).toEqual([]);
    expect(transition).toHaveBeenCalledWith("evt_1", "FAILED", { error: "Unknown event type" });
  });

  it("keeps processing the rest of the batch after a failing record", async () => {
    // A `throw` (or an early return) here would abandon the remaining records
    // AND retry the whole batch. Every record must be attempted.
    const result = await handler({
      Records: [
        sqsRecord("msg-1", envelope({ event_id: "evt_a", type: "FLAKY" })),
        sqsRecord("msg-2", envelope({ event_id: "evt_b" })),
        sqsRecord("msg-3", envelope({ event_id: "evt_c", type: "FLAKY" })),
      ],
    });

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "msg-1" },
      { itemIdentifier: "msg-3" },
    ]);
    expect(insertStarted).toHaveBeenCalledTimes(3);
  });

  it("an empty batch returns no failures and touches no record", async () => {
    const result = await handler({ Records: [] });

    expect(result.batchItemFailures).toEqual([]);
    expect(insertStarted).not.toHaveBeenCalled();
  });
});

describe("handler — malformed bodies are permanent", () => {
  it("a body that fails EnvelopeSchema is not retried and does not throw", async () => {
    const result = await handler({
      Records: [sqsRecord("msg-malformed", { not: "a valid envelope" })],
    });

    expect(result.batchItemFailures).toEqual([]);
    // Nothing can be persisted: without a valid event_id there is no document
    // to write against.
    expect(insertStarted).not.toHaveBeenCalled();
  });

  it("a body that is not JSON at all is not retried and does not throw", async () => {
    const result = await handler({ Records: [{ messageId: "msg-junk", body: "<<<not json" }] });

    expect(result.batchItemFailures).toEqual([]);
    expect(insertStarted).not.toHaveBeenCalled();
  });

  it("a malformed record does not poison the valid records beside it", async () => {
    const result = await handler({
      Records: [
        sqsRecord("msg-malformed", { not: "valid" }),
        sqsRecord("msg-good", envelope()),
      ],
    });

    expect(result.batchItemFailures).toEqual([]);
    expect(insertStarted).toHaveBeenCalledOnce();
  });

  it("logs the rejection at ERROR with a reason, and never echoes the raw body", async () => {
    const secret = { not: "valid", email: "leak@example.com", password: "hunter2" };
    await handler({ Records: [sqsRecord("msg-malformed", secret)] });

    const failed = emitted().find((l) => l.line.app_event === "event_processing_failed");
    expect(failed?.level).toBe("error");
    expect(failed?.line.reason).toBe("invalid_envelope");
    // The full body would carry PII (and passwords) straight into CloudWatch.
    const serialized = rawLines.join("\n");
    expect(serialized).not.toContain("leak@example.com");
    expect(serialized).not.toContain("hunter2");
  });
});

describe("handler — index bootstrap", () => {
  it("ensures indexes on the first invocation", async () => {
    await handler({ Records: [sqsRecord("msg-1", envelope())] });

    expect(ensureIndexes).toHaveBeenCalledOnce();
  });

  it("does not re-run ensureIndexes on a warm second invocation", async () => {
    await handler({ Records: [sqsRecord("msg-1", envelope())] });
    await handler({ Records: [sqsRecord("msg-2", envelope({ event_id: "evt_2" }))] });

    expect(ensureIndexes).toHaveBeenCalledOnce();
  });

  it("retries the bootstrap on the next invocation if it failed", async () => {
    ensureIndexes.mockRejectedValueOnce(new Error("docdb unreachable"));

    // A failed bootstrap must not latch the flag: the whole batch is reported
    // transient so SQS redelivers it, and the next invocation tries again.
    const first = await handler({ Records: [sqsRecord("msg-1", envelope())] });
    expect(first.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);

    await handler({ Records: [sqsRecord("msg-2", envelope({ event_id: "evt_2" }))] });
    expect(ensureIndexes).toHaveBeenCalledTimes(2);
  });
});

describe("handler — infrastructure failures fail the whole batch transiently", () => {
  it("an unreachable database reports every record as a batch item failure", async () => {
    getMongoClient.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const result = await handler({
      Records: [
        sqsRecord("msg-1", envelope({ event_id: "evt_a" })),
        sqsRecord("msg-2", envelope({ event_id: "evt_b" })),
      ],
    });

    // Nothing was processed, so nothing may be consumed — all of it must come
    // back. Throwing would also retry the batch, but loses the structured log.
    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "msg-1" },
      { itemIdentifier: "msg-2" },
    ]);
  });
});

describe("handler — duplicate redeliveries", () => {
  it("is consumed (not retried) and logged at INFO, not ERROR", async () => {
    insertStarted.mockRejectedValueOnce(new DuplicateEventError("evt_1"));

    const result = await handler({ Records: [sqsRecord("msg-dup", envelope())] });

    expect(result.batchItemFailures).toEqual([]);
    const dup = emitted().find((l) => l.line.app_event === "event_processing_skipped");
    expect(dup?.level).toBe("info");
    expect(dup?.line.reason).toBe("duplicate_event");
    // A redelivery is benign; nothing about it is an ERROR.
    expect(emitted().filter((l) => l.level === "error")).toEqual([]);
  });
});

describe("handler — a failing insert does not leak the document into the log", () => {
  it("never logs a driver error message that embeds the offending document", async () => {
    // MongoDB write errors (DocumentValidationFailure, BSONObjectTooLarge, a
    // duplicate key on a COMPOUND index) echo the rejected document back in
    // their message — which is the payload, with the user's email and whatever
    // else the producer sent. This is the same hazard as the Zod one, arriving
    // through the insert path instead of the parse path.
    insertStarted.mockRejectedValueOnce(
      new Error(
        'E11000 duplicate key error collection: events.events dup key: { payload: { email: "leak@example.com", password: "hunter2" } }',
      ),
    );

    const result = await handler({ Records: [sqsRecord("msg-1", envelope())] });

    // Still reported transient (unclassified) — only the LOG is sanitized.
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);

    const serialized = rawLines.join("\n");
    expect(serialized).not.toContain("leak@example.com");
    expect(serialized).not.toContain("hunter2");

    // The failure is still reported — sanitizing must not mean going silent.
    const failed = emitted().find((l) => l.line.app_event === "event_processing_failed");
    expect(failed?.level).toBe("error");
    expect(failed?.line.reason).toBeDefined();
  });

  it("still distinguishes a duplicate redelivery from a generic insert failure", async () => {
    // The sanitization must not flatten DuplicateEventError into the generic
    // branch: that would turn a benign redelivery back into an ERROR + retry.
    insertStarted.mockRejectedValueOnce(new DuplicateEventError("evt_1"));

    const result = await handler({ Records: [sqsRecord("msg-dup", envelope())] });

    expect(result.batchItemFailures).toEqual([]);
    expect(emitted().find((l) => l.line.app_event === "event_processing_skipped")?.level).toBe("info");
  });
});

describe("handler — a throwing transition", () => {
  it("reports the record transiently rather than aborting the batch", async () => {
    // processRecord guards the handler and the insert, but NOT its own
    // transition calls: if one throws mid-flight the document is persisted with
    // a now-stale status, and the record must come back for a retry.
    transition.mockRejectedValueOnce(new Error("connection reset mid-transition"));

    const result = await handler({
      Records: [
        sqsRecord("msg-1", envelope({ event_id: "evt_a" })),
        sqsRecord("msg-2", envelope({ event_id: "evt_b" })),
      ],
    });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    const failed = emitted().find((l) => l.line.app_event === "event_processing_failed");
    expect(failed?.level).toBe("error");
    expect(failed?.line.transient).toBe(true);
    // The rest of the batch is still processed.
    expect(emitted().some((l) => l.line.app_event === "event_processing_succeeded")).toBe(true);
  });
});

describe("handler — per-record failure isolation", () => {
  it("gives two failing records in one batch their OWN reason", async () => {
    // observe() is created INSIDE the loop, so each record gets a fresh
    // outcome. Hoisting it out of the loop would make the second record report
    // the first one's reason — the invariant most likely to break under later
    // edits, and invisible without this test.
    const result = await handler({
      Records: [
        sqsRecord("msg-1", envelope({ event_id: "evt_a", type: "FLAKY" })),
        sqsRecord("msg-2", envelope({ event_id: "evt_b", type: "BROKEN" })),
      ],
    });

    const failures = emitted().filter((l) => l.line.app_event === "event_processing_failed");
    const byEvent = new Map(failures.map((l) => [l.line.event_id, l.line.reason]));

    expect(byEvent.get("evt_a")).toBe("simulated outage");
    expect(byEvent.get("evt_b")).toBe("unprocessable payload");
    // FLAKY is transient, BROKEN is permanent — only the former is retried.
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
  });

  it("does not carry a previous record's DUPLICATE flag onto a later failing one", async () => {
    // The sharpest test of per-record isolation. `outcome.duplicate` latches
    // true and is never reset, so a single `observe()` shared across the loop
    // would make this second, genuinely-failing record take the duplicate
    // branch: logged INFO as "already processed" and CONSUMED, when it should
    // be an ERROR that comes back for a retry. Silent event loss.
    insertStarted
      .mockRejectedValueOnce(new DuplicateEventError("evt_dup"))
      .mockRejectedValueOnce(new Error("connection reset"));

    const result = await handler({
      Records: [
        sqsRecord("msg-dup", envelope({ event_id: "evt_dup" })),
        sqsRecord("msg-fail", envelope({ event_id: "evt_fail" })),
      ],
    });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-fail" }]);

    const skipped = emitted().filter((l) => l.line.app_event === "event_processing_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.line.event_id).toBe("evt_dup");

    const failed = emitted().filter((l) => l.line.app_event === "event_processing_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.line.event_id).toBe("evt_fail");
    expect(failed[0]?.level).toBe("error");
  });

  it("does not carry a previous record's reason onto a later successful one", async () => {
    await handler({
      Records: [
        sqsRecord("msg-1", envelope({ event_id: "evt_a", type: "FLAKY" })),
        sqsRecord("msg-2", envelope({ event_id: "evt_b" })),
      ],
    });

    const succeeded = emitted().find((l) => l.line.app_event === "event_processing_succeeded");
    expect(succeeded?.line.event_id).toBe("evt_b");
    expect(succeeded?.line).not.toHaveProperty("reason");
  });
});

describe("handler — log context", () => {
  it("carries event_id, user_id, order_id and type on the flow logs", async () => {
    await handler({
      Records: [
        sqsRecord(
          "msg-1",
          envelope({ event_id: "evt_ctx", user_id: "usr_ctx", order_id: "ord_ctx" }),
        ),
      ],
    });

    const started = emitted().find((l) => l.line.app_event === "event_processing_started");
    const succeeded = emitted().find((l) => l.line.app_event === "event_processing_succeeded");

    expect(started?.line).toMatchObject({
      event_id: "evt_ctx",
      user_id: "usr_ctx",
      order_id: "ord_ctx",
      type: "USER_CREATED",
    });
    expect(succeeded?.level).toBe("info");
    expect(succeeded?.line.event_id).toBe("evt_ctx");
  });

  it("omits order_id entirely when it is null — never emits it as null", async () => {
    await handler({ Records: [sqsRecord("msg-1", envelope({ order_id: null }))] });

    const started = emitted().find((l) => l.line.app_event === "event_processing_started");
    expect(started?.line).not.toHaveProperty("order_id");
  });

  it("emits *_failed with a reason when the handler fails", async () => {
    await handler({ Records: [sqsRecord("msg-1", envelope({ type: "FLAKY" }))] });

    const failed = emitted().find((l) => l.line.app_event === "event_processing_failed");
    expect(failed?.level).toBe("error");
    expect(failed?.line.reason).toBe("simulated outage");
    expect(failed?.line.transient).toBe(true);
  });

  it("never logs the payload", async () => {
    await handler({
      Records: [sqsRecord("msg-1", envelope({ payload: { email: "leak@example.com" } }))],
    });

    expect(rawLines.join("\n")).not.toContain("leak@example.com");
  });

  it("carries the author on every line for the record, flattened under author_*", async () => {
    await handler({
      Records: [
        sqsRecord(
          "msg-1",
          envelope({
            author: {
              actor: "users_api:register",
              user_id: "usr_author",
              cognito_sub: "a1b2-c3d4",
            },
          }),
        ),
      ],
    });

    const started = emitted().find((l) => l.line.app_event === "event_processing_started");
    const succeeded = emitted().find((l) => l.line.app_event === "event_processing_succeeded");

    for (const line of [started?.line, succeeded?.line]) {
      expect(line).toMatchObject({
        author_actor: "users_api:register",
        author_user_id: "usr_author",
        author_cognito_sub: "a1b2-c3d4",
      });
    }
    // Flattened, not nested: a nested object is not a field the collector can
    // filter on the way every other shared-context key is.
    expect(started?.line).not.toHaveProperty("author");
  });

  it("does NOT let the author's user_id collide with the subject user_id", async () => {
    // The sharpest test of the naming decision. The two identities differ here,
    // so a shared `user_id` key would silently overwrite the subject and the
    // line would attribute the event to the wrong user while looking correct.
    await handler({
      Records: [
        sqsRecord(
          "msg-1",
          envelope({
            user_id: "usr_subject",
            author: { actor: "users_api:update_profile", user_id: "usr_author" },
          }),
        ),
      ],
    });

    const started = emitted().find((l) => l.line.app_event === "event_processing_started");
    expect(started?.line.user_id).toBe("usr_subject");
    expect(started?.line.author_user_id).toBe("usr_author");
  });

  it("omits author_user_id and author_cognito_sub when no human originated the event", async () => {
    // The carrier webhook. Omitted, NEVER null and never backfilled with the
    // actor label — the rule from docs/shared/conventions/logging-context.md.
    await handler({
      Records: [
        sqsRecord(
          "msg-1",
          envelope({
            type: "USER_CREATED",
            author: { actor: "tracking_api:carrier_status_update" },
          }),
        ),
      ],
    });

    const started = emitted().find((l) => l.line.app_event === "event_processing_started");
    expect(started?.line.author_actor).toBe("tracking_api:carrier_status_update");
    expect(started?.line).not.toHaveProperty("author_user_id");
    expect(started?.line).not.toHaveProperty("author_cognito_sub");
  });

  it("does not carry one record's author onto the next record's lines", async () => {
    // Per-record ALS scoping, checked on the author the same way it is on
    // event_id: a store shared across the loop would leak the first author
    // onto the second record.
    await handler({
      Records: [
        sqsRecord(
          "msg-1",
          envelope({
            event_id: "evt_a",
            author: { actor: "users_api:register", user_id: "usr_a" },
          }),
        ),
        sqsRecord(
          "msg-2",
          envelope({
            event_id: "evt_b",
            author: { actor: "tracking_api:carrier_status_update" },
          }),
        ),
      ],
    });

    const byEvent = new Map(
      emitted()
        .filter((l) => l.line.app_event === "event_processing_started")
        .map((l) => [l.line.event_id, l.line]),
    );

    expect(byEvent.get("evt_a")).toMatchObject({
      author_actor: "users_api:register",
      author_user_id: "usr_a",
    });
    expect(byEvent.get("evt_b")?.author_actor).toBe("tracking_api:carrier_status_update");
    expect(byEvent.get("evt_b")).not.toHaveProperty("author_user_id");
  });

  it("never puts an email on the author, and none reaches the log", async () => {
    // cognito_sub is an identifier and is loggable; an email is not, and the
    // schema has no field for one. A producer smuggling one in an unknown key
    // must not reach a line either.
    await handler({
      Records: [
        sqsRecord(
          "msg-1",
          envelope({
            author: {
              actor: "users_api:register",
              user_id: "usr_1",
              cognito_sub: "a1b2-c3d4",
              email: "leak@example.com",
            },
          }),
        ),
      ],
    });

    expect(rawLines.join("\n")).not.toContain("leak@example.com");
    const started = emitted().find((l) => l.line.app_event === "event_processing_started");
    expect(started?.line.author_cognito_sub).toBe("a1b2-c3d4");
  });

  it("does not emit a SUCCESS severity — success is INFO plus app_event", async () => {
    await handler({ Records: [sqsRecord("msg-1", envelope())] });

    // Checked on severity_text/severity_number, the fields pino actually emits:
    // SUCCESS is not an OTel severity, so inventing one would break severity
    // coloring and every standard severity filter downstream.
    for (const { line } of emitted()) {
      expect(line.severity_text).not.toBe("SUCCESS");
      expect([5, 9, 13, 17]).toContain(line.severity_number);
    }
    const succeeded = emitted().find((l) => l.line.app_event === "event_processing_succeeded");
    expect(succeeded).toBeDefined();
    expect(succeeded?.line.severity_text).toBe("INFO");
  });
});
