import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { TransientError, PermanentError } from "#pipeline/errors";
import {
  flushTraces,
  mockTracingModule,
  originTracer,
  resetTracingHarness,
  spanExporter,
} from "./tracing-harness.ts";

// FILE-WIDE, not inside the tracing describe: the handler imports the real
// tracing module, which calls sdk.start() and opens an OTLP exporter at import
// time. Every test in this file would then hang on `await flushTraces()` until
// Vitest's 5s timeout. See tests/tracing-harness.ts.
mockTracingModule();

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
// Required by the schema since the templates moved to remote images. Any valid
// absolute URL without a trailing slash satisfies it — this suite never renders
// a template, let alone fetches one of these URLs.
vi.stubEnv("ASSETS_BASE_URL", "http://assets.test/bucket");

vi.mock("#shared/db/client", () => ({
  getMongoClient: (...args: unknown[]) => getMongoClient(...(args as [])),
}));
// One test needs the REAL repository, to prove the manual `documentdb insertOne`
// span lands under the real `process_record` span rather than under a stub's
// idea of it. A flag rather than a second test file: everything else in this
// suite wants the fast stub.
const { useRealRepository } = vi.hoisted(() => ({ useRealRepository: { value: false } }));

vi.mock("#shared/db/events-repository", async () => {
  // DuplicateEventError is re-exported from the real module: the handler
  // classifies on `instanceof`, and a stubbed class would silently never match.
  const actual = await vi.importActual<typeof import("#shared/db/events-repository")>(
    "#shared/db/events-repository",
  );
  return {
    ...actual,
    MongoEventsRepository: vi.fn(() =>
      useRealRepository.value
        ? // A real instance over a fake driver: the repository's own span code
          // runs, only the mongo round trip is faked.
          new actual.MongoEventsRepository({
            collection: () => ({
              insertOne: async () => ({}),
              updateOne: async () => ({}),
            }),
          } as never)
        : { insertStarted, transition },
    ),
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

// Spied rather than left real: the scheduled-tick tests assert exactly WHICH
// series get seeded, and a real publish would need a CloudWatch client.
const publishMetric = vi.fn(async () => {});
vi.mock("#shared/metrics/cloudwatch-metrics", () => ({
  SERVICE_DIMENSION: "events-pipeline",
  publishMetric: (...args: unknown[]) => publishMetric(...(args as [])),
  publishEmailMetric: vi.fn(async () => {}),
}));

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
  resetTracingHarness();
  useRealRepository.value = false;
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

  it("carries the envelope's request_id on EVERY line of that record's processing", async () => {
    // This function runs no OTel SDK, so there is no trace_id on these lines:
    // request_id is the only thing tying the work back to the request that
    // caused it. It is read off the envelope — this service never mints one.
    await handler({
      Records: [
        sqsRecord("msg-1", envelope({ request_id: "req_V1StGXR8Z5jdHi6BmyT" })),
      ],
    });

    const lines = emitted();
    expect(lines.length).toBeGreaterThan(0);
    // Every line, not just the flow logs — that is the whole point of putting
    // it in the ALS store rather than on individual call sites.
    for (const { line } of lines) {
      expect(line.request_id).toBe("req_V1StGXR8Z5jdHi6BmyT");
    }
  });

  it("OMITS request_id when the envelope has none — never emits it as null", async () => {
    // The in-flight-message case: a record published before the producers sent
    // this field. It must process completely normally, and its lines must have
    // NO request_id key at all — a null would read as "correlated, to nothing"
    // rather than "this message predates the field".
    const result = await handler({ Records: [sqsRecord("msg-1", envelope())] });

    expect(result.batchItemFailures).toEqual([]);
    expect(insertStarted).toHaveBeenCalledOnce();

    const lines = emitted();
    expect(lines.length).toBeGreaterThan(0);
    for (const { line } of lines) {
      expect(line).not.toHaveProperty("request_id");
    }
    // And it really did run the whole flow, not just fail quietly.
    expect(lines.some((l) => l.line.app_event === "event_processing_succeeded")).toBe(true);
  });

  it("does not carry one record's request_id onto the next record's lines", async () => {
    // Per-record ALS scoping again, on the field where a leak is worst: a
    // request_id bleeding onto a neighbouring record would attribute that
    // record's work to a request that never caused it.
    await handler({
      Records: [
        sqsRecord("msg-1", envelope({ event_id: "evt_a", request_id: "req_V1StGXR8Z5jdHi6BmyT" })),
        sqsRecord("msg-2", envelope({ event_id: "evt_b" })),
      ],
    });

    const byEvent = new Map(
      emitted()
        .filter((l) => l.line.app_event === "event_processing_started")
        .map((l) => [l.line.event_id, l.line]),
    );

    expect(byEvent.get("evt_a")?.request_id).toBe("req_V1StGXR8Z5jdHi6BmyT");
    expect(byEvent.get("evt_b")).not.toHaveProperty("request_id");
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

  // The scheduled tick (EventBridge rate(1 minute), see infra/environments/local/main.tf).
  // It exists because the email counters only emit when mail moves, so a quiet
  // dashboard window had no datapoints at all and the metric panel threw
  // instead of rendering 0.
  describe("metrics tick", () => {
    const tick = { "detail-type": "3mrai.metrics.tick" };

    it("seeds every email counter at zero", async () => {
      await handler(tick);

      const seeded = publishMetric.mock.calls.map((c) => {
        const [name, value, dims] = c as unknown as [string, number, Record<string, string>];
        return { name, value, dims };
      });

      // Every seeded series carries 0 — a non-zero seed would inflate real counts.
      expect(seeded.every((s) => s.value === 0)).toBe(true);

      // Both failure KINDS, not just the metric: the dashboard has a card per
      // kind, and seeding only one leaves the other throwing.
      expect(
        seeded.filter((s) => s.name === "emails_failed_total").map((s) => s.dims.FailureKind).sort(),
      ).toEqual(["permanent", "transient"]);
      expect(seeded.some((s) => s.name === "emails_sent_total")).toBe(true);
    });

    it("does not touch the database or process records", async () => {
      await handler(tick);

      // The whole point of the early return. A tick carries no records, so
      // opening a connection would be per-minute waste — and any future work in
      // the record loop would run on a schedule against an empty batch.
      expect(getMongoClient).not.toHaveBeenCalled();
      expect(insertStarted).not.toHaveBeenCalled();
    });

    it("still processes a normal SQS batch, and does NOT seed on that path", async () => {
      // The regression this pair guards: seeding used to live at the top of the
      // SQS path, where it ran only when mail was already flowing — publishing
      // zeros exactly when they were not needed and nothing during the quiet
      // windows they were meant to cover.
      await handler({ Records: [sqsRecord("msg-1", envelope())] });

      expect(insertStarted).toHaveBeenCalledOnce();
      expect(publishMetric).not.toHaveBeenCalled();
    });

    it("treats a malformed SQS event as SQS, not as a tick", async () => {
      // isMetricsTick matches on detail-type rather than on the ABSENCE of
      // Records. If it matched on shape, a malformed delivery would be silently
      // swallowed as a tick — dropped mail reported as success.
      await expect(handler({ Records: undefined } as never)).rejects.toThrow();
      expect(publishMetric).not.toHaveBeenCalled();
    });
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


describe("handler — tracing", () => {
  // A real W3C traceparent for a synthetic ORIGIN trace, standing in for the
  // publisher (Users/Orders/Tracking) that put the message on the queue. Built
  // from a real span context rather than a hand-written hex string so the test
  // exercises the same decode path a live message travels.
  async function originTraceparent(): Promise<{
    traceparent: string;
    traceId: string;
    spanId: string;
  }> {
    const span = originTracer.startSpan("origin-publish");
    const { traceId, spanId } = span.spanContext();
    span.end();
    return { traceparent: `00-${traceId}-${spanId}-01`, traceId, spanId };
  }

  function tracedRecord(messageId: string, body: unknown, traceparent: string) {
    return {
      ...sqsRecord(messageId, body),
      messageAttributes: { traceparent: { stringValue: traceparent } },
    };
  }

  function spansNamed(name: string) {
    return spanExporter.getFinishedSpans().filter((s) => s.name === name);
  }

  it("opens a CONSUMER span for the batch with the record count on it", async () => {
    await handler({ Records: [sqsRecord("msg-1", envelope())] });

    const [batchSpan] = spansNamed("events-queue process");
    expect(batchSpan).toBeDefined();
    expect(batchSpan.kind).toBe(SpanKind.CONSUMER);
    expect(batchSpan.attributes["messaging.system"]).toBe("aws_sqs");
    expect(batchSpan.attributes["messaging.batch.message_count"]).toBe(1);
    expect(batchSpan.status.code).toBe(SpanStatusCode.OK);
  });

  it("parents the record span to the origin span when the batch holds exactly ONE record", async () => {
    // The whole point of the hybrid: with a single record the origin is
    // unambiguous, so the record span is a REAL CHILD of the publisher's span
    // and stays in the publisher's trace. That is what makes the email work
    // visible inside the create_order trace instead of stranded in a second one
    // reachable only by following a FOLLOWS_FROM reference.
    const { traceparent, traceId, spanId } = await originTraceparent();

    await handler({ Records: [tracedRecord("msg-1", envelope(), traceparent)] });

    const [batchSpan] = spansNamed("events-queue process");
    const [recordSpan] = spansNamed("process_record");
    expect(recordSpan).toBeDefined();
    expect(recordSpan.kind).toBe(SpanKind.INTERNAL);
    expect(recordSpan.attributes["messaging.message.id"]).toBe("msg-1");
    expect(recordSpan.parentSpanContext?.spanId).toBe(spanId);
    expect(recordSpan.spanContext().traceId).toBe(traceId);
    // A parent REPLACES the link — keeping both would draw the same edge twice.
    expect(recordSpan.links).toHaveLength(0);
    // And it leaves the batch span's trace: the record now belongs to the
    // publisher's, which is exactly the join being bought here.
    expect(recordSpan.parentSpanContext?.spanId).not.toBe(batchSpan.spanContext().spanId);
    expect(recordSpan.spanContext().traceId).not.toBe(batchSpan.spanContext().traceId);
  });

  it("carries the whole cascade into the origin trace for a single-record batch", async () => {
    // Parenting is worth nothing if the children do not follow: the reason the
    // user saw no email in the create_order trace was a BREAK one level up.
    // Asserting the DocumentDB span's trace id is what proves the join reaches
    // the leaves, not just the record span.
    useRealRepository.value = true;
    const { traceparent, traceId } = await originTraceparent();

    await handler({ Records: [tracedRecord("msg-1", envelope(), traceparent)] });

    const [recordSpan] = spansNamed("process_record");
    const [persistSpan] = spansNamed("phase persist");
    const [dbSpan] = spansNamed("documentdb insertOne");
    expect(dbSpan).toBeDefined();
    // Through the phase span, which is the leaf's actual parent now — the trace
    // id is what this test is really about, and it must survive the extra level.
    expect(dbSpan.parentSpanContext?.spanId).toBe(persistSpan.spanContext().spanId);
    expect(persistSpan.parentSpanContext?.spanId).toBe(recordSpan.spanContext().spanId);
    expect(dbSpan.spanContext().traceId).toBe(traceId);
    expect(persistSpan.spanContext().traceId).toBe(traceId);
  });

  it("links — never parents — each record of a MULTI-record batch to its OWN origin trace", async () => {
    // The branch that rots without a test. Batch size is a runtime property: SQS
    // delivers several records per invocation under load, and then a single
    // parent would have to pick one of N origins and misattribute every other
    // record. Each record gets its own link instead, and the spans stay in this
    // Lambda's trace, under the batch span.
    const first = await originTraceparent();
    const second = await originTraceparent();

    await handler({
      Records: [
        tracedRecord("msg-1", envelope({ event_id: "evt_a" }), first.traceparent),
        tracedRecord("msg-2", envelope({ event_id: "evt_b" }), second.traceparent),
      ],
    });

    const [batchSpan] = spansNamed("events-queue process");
    const recordSpans = spansNamed("process_record");
    expect(recordSpans).toHaveLength(2);
    expect(recordSpans[0].links[0].context.traceId).toBe(first.traceId);
    expect(recordSpans[1].links[0].context.traceId).toBe(second.traceId);
    expect(first.traceId).not.toBe(second.traceId);

    for (const recordSpan of recordSpans) {
      expect(recordSpan.links).toHaveLength(1);
      // NO remote parent: both spans stay children of the batch span, in this
      // Lambda's own trace. This is the assertion that fails the day someone
      // "simplifies" the hybrid into always-parent.
      expect(recordSpan.parentSpanContext?.spanId).toBe(batchSpan.spanContext().spanId);
      expect(recordSpan.spanContext().traceId).toBe(batchSpan.spanContext().traceId);
    }
    expect(recordSpans[0].spanContext().traceId).not.toBe(first.traceId);
    expect(recordSpans[1].spanContext().traceId).not.toBe(second.traceId);
  });

  it("falls back to neither parent nor link, and no failure, for a record with no traceparent", async () => {
    // The pre-instrumentation shape: a message published (or redelivered) before
    // the publishers injected a traceparent. Absent is a valid shape, not a
    // fault — it must not cost the record its processing. A single-record batch
    // on purpose: the branch that WOULD parent has nothing to parent to, and
    // must fall back to the batch span rather than orphan the record.
    const result = await handler({ Records: [sqsRecord("msg-2", envelope())] });

    expect(result.batchItemFailures).toEqual([]);
    const [batchSpan] = spansNamed("events-queue process");
    const [recordSpan] = spansNamed("process_record");
    expect(recordSpan).toBeDefined();
    expect(recordSpan.links).toHaveLength(0);
    expect(recordSpan.parentSpanContext?.spanId).toBe(batchSpan.spanContext().spanId);
    expect(recordSpan.spanContext().traceId).toBe(batchSpan.spanContext().traceId);
  });

  it("falls back to neither parent nor link for a malformed traceparent, and still processes the record", async () => {
    const result = await handler({
      Records: [tracedRecord("msg-3", envelope(), "not-a-traceparent")],
    });

    expect(result.batchItemFailures).toEqual([]);
    expect(insertStarted).toHaveBeenCalledOnce();
    const [batchSpan] = spansNamed("events-queue process");
    const [recordSpan] = spansNamed("process_record");
    expect(recordSpan.links).toHaveLength(0);
    // An undecodable traceparent must not become a parent either: the record
    // stays under the batch span, in this Lambda's trace.
    expect(recordSpan.parentSpanContext?.spanId).toBe(batchSpan.spanContext().spanId);
    expect(recordSpan.spanContext().traceId).toBe(batchSpan.spanContext().traceId);
  });

  it("marks only the failing record's span ERROR, leaving its sibling and the batch OK", async () => {
    // The trace-side counterpart of batchItemFailures: one bad record must not
    // paint the whole batch red.
    await handler({
      Records: [
        sqsRecord("msg-good", envelope({ event_id: "evt_good" })),
        sqsRecord("msg-bad", envelope({ event_id: "evt_bad", type: "FLAKY" })),
      ],
    });

    const [good, bad] = spansNamed("process_record");
    expect(good.status.code).toBe(SpanStatusCode.OK);
    expect(bad.status.code).toBe(SpanStatusCode.ERROR);
    expect(spansNamed("events-queue process")[0].status.code).toBe(SpanStatusCode.OK);
  });

  it("flushes the span processor before returning", async () => {
    // Lambda freezes the process on return: without this the batch processor's
    // buffer is lost, or shipped on a later invocation under the wrong request.
    await handler({ Records: [sqsRecord("msg-1", envelope())] });

    expect(flushTraces).toHaveBeenCalledOnce();
  });

  it("ends the batch span and flushes even when the batch throws", async () => {
    // The `finally` is the whole point: a span left unended never reaches
    // Jaeger, and it does not surface as an error — it silently vanishes.
    await expect(handler({ Records: undefined } as never)).rejects.toThrow();

    const [batchSpan] = spansNamed("events-queue process");
    expect(batchSpan).toBeDefined();
    expect(batchSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(flushTraces).toHaveBeenCalledOnce();
  });

  it("nests the real DocumentDB span under the persist phase, under process_record", async () => {
    // The whole cascade in one assertion, against the REAL repository:
    // events-queue process -> process_record -> phase persist -> documentdb
    // insertOne. Asserting only that "a span reached the exporter" would pass just
    // as happily with an orphaned span, which is what a broken ambient context
    // actually produces.
    //
    // The phase span sits BETWEEN the record and the write, which is the point of
    // it: the waterfall groups a lifecycle stage into one bar in both viewers,
    // where the span EVENTS that used to mark these boundaries were rendered by
    // neither. That extra level is exactly what this test pins — drop the phase
    // and the chain silently flattens back.
    useRealRepository.value = true;

    await handler({ Records: [sqsRecord("msg-1", envelope())] });

    const [batchSpan] = spansNamed("events-queue process");
    const [recordSpan] = spansNamed("process_record");
    const [persistSpan] = spansNamed("phase persist");
    const [dbSpan] = spansNamed("documentdb insertOne");

    expect(persistSpan).toBeDefined();
    expect(persistSpan.kind).toBe(SpanKind.INTERNAL);
    expect(dbSpan).toBeDefined();
    expect(dbSpan.kind).toBe(SpanKind.CLIENT);

    // The full chain, link by link.
    expect(dbSpan.parentSpanContext?.spanId).toBe(persistSpan.spanContext().spanId);
    expect(persistSpan.parentSpanContext?.spanId).toBe(recordSpan.spanContext().spanId);
    expect(recordSpan.parentSpanContext?.spanId).toBe(batchSpan.spanContext().spanId);
    // The write hangs off the RECORD's subtree, not the batch — the distinction
    // the whole per-record span design exists for.
    expect(dbSpan.parentSpanContext?.spanId).not.toBe(batchSpan.spanContext().spanId);
    expect(dbSpan.spanContext().traceId).toBe(batchSpan.spanContext().traceId);
  });

  it("stamps the record span's trace_id and span_id on that record's log lines", async () => {
    // The issue's own acceptance criterion: a log line must carry the id of the
    // trace it belongs to, or logs and traces cannot be joined at all.
    await handler({ Records: [sqsRecord("msg-1", envelope())] });

    const [recordSpan] = spansNamed("process_record");
    const succeeded = emitted().find((l) => l.line.app_event === "event_processing_succeeded");
    expect(succeeded).toBeDefined();
    expect(succeeded!.line.trace_id).toBe(recordSpan.spanContext().traceId);
    expect(succeeded!.line.span_id).toBe(recordSpan.spanContext().spanId);
  });

  it("opens an unlinked CONSUMER span for the scheduled tick and flushes it", async () => {
    // The tick originates from an EventBridge timer, not from a published
    // message: there is no origin trace to link to, so linking it to anything
    // would be an invention.
    await handler({ "detail-type": "3mrai.metrics.tick" } as never);

    const [tickSpan] = spansNamed("metrics-tick");
    expect(tickSpan).toBeDefined();
    expect(tickSpan.kind).toBe(SpanKind.CONSUMER);
    expect(tickSpan.links).toHaveLength(0);
    expect(tickSpan.status.code).toBe(SpanStatusCode.OK);
    expect(spansNamed("events-queue process")).toHaveLength(0);
    expect(flushTraces).toHaveBeenCalledOnce();
  });
});
