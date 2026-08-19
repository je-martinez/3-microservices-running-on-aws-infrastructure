import { describe, it, expect } from "vitest";
import pino from "pino";
// The harness's provider, imported for its TRACER only — no `mockTracingModule()`
// call here, because this suite never loads a module that imports the tracing
// bootstrap. Importing the harness does install a real context manager, which is
// exactly what makes `startActiveSpan` below actually activate a span.
import { pipelineTracer } from "../../tracing-harness.ts";
import { buildLoggerOptions, SEVERITY_NUMBER } from "#shared/logging/logger";
import { runWithLogContext, setLogContext } from "#shared/logging/log-context";

// A destination stream instead of a console spy: pino writes to its destination,
// never through console, so a spy would capture nothing. Collecting the raw
// lines here also means these tests assert the SERIALIZED record — the thing
// CloudWatch and the OTel collector actually receive — rather than the object
// handed to the logger.
function capture(): { lines: string[]; stream: { write: (s: string) => void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => lines.push(s) } };
}

function buildLogger(stream: { write: (s: string) => void }) {
  return pino(
    buildLoggerOptions({ serviceName: "events-pipeline", environment: "local" }),
    stream,
  );
}

describe("buildLoggerOptions", () => {
  it("emits the snake_case OTel-aligned schema", () => {
    const { lines, stream } = capture();
    const log = buildLogger(stream);

    log.info({ event_id: "evt_1" }, "processing event");

    const rec = JSON.parse(lines[0]);
    expect(rec.severity_text).toBe("INFO");
    expect(rec.severity_number).toBe(SEVERITY_NUMBER.INFO);
    expect(rec.service_name).toBe("events-pipeline");
    expect(rec.deployment_environment).toBe("local");
    expect(rec.message).toBe("processing event");
    expect(rec.event_id).toBe("evt_1");
    expect(rec.timestamp).toBeDefined();
    // Pino's own keys must be GONE, not merely duplicated: a numeric `level`
    // beside `severity_number` is what makes a record fail to line up with the
    // other three services in a shared OpenObserve stream.
    expect(rec.level).toBeUndefined();
    expect(rec.msg).toBeUndefined();
  });

  it("maps each severity to its OTel number", () => {
    const { lines, stream } = capture();
    // DEBUG is below pino's default `info` level and would be dropped, so this
    // logger opts into it — process-record.ts logs status transitions at DEBUG.
    const log = pino(
      { ...buildLoggerOptions({ serviceName: "events-pipeline", environment: "local" }), level: "debug" },
      stream,
    );

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    const records = lines.map((l) => JSON.parse(l));
    expect(records.map((r) => r.severity_text)).toEqual(["DEBUG", "INFO", "WARN", "ERROR"]);
    expect(records.map((r) => r.severity_number)).toEqual([5, 9, 13, 17]);
  });

  it("promotes err to top-level error_type/error_message with the CONCRETE class name", () => {
    // `err.name` would be "Error" here — only `err.constructor.name` reports the
    // subclass, which is what makes TransientError distinguishable from
    // PermanentError in a query.
    class TransientError extends Error {}
    const { lines, stream } = capture();
    const log = buildLogger(stream);

    log.error({ err: new TransientError("boom") }, "failed");

    const rec = JSON.parse(lines[0]);
    expect(rec.error_type).toBe("TransientError");
    expect(rec.error_message).toBe("boom");
  });

  it("falls back to type for an already-serialized err with no constructor", () => {
    // A PLAIN object literal would not reach the fallback: its
    // `constructor.name` is "Object", which is truthy and wins the `??` chain.
    // The fallback exists for a prototype-less object — what a serialized error
    // arrives as when it has crossed a structuredClone or a JSON round-trip
    // through Object.create(null).
    const serialized = Object.assign(Object.create(null), {
      type: "SerializedError",
      message: "boom",
    });
    const { lines, stream } = capture();
    const log = buildLogger(stream);

    log.error({ err: serialized }, "failed");

    const rec = JSON.parse(lines[0]);
    expect(rec.error_type).toBe("SerializedError");
    expect(rec.error_message).toBe("boom");
  });

  it("does not add error_type/error_message to a normal log with no err", () => {
    const { lines, stream } = capture();
    const log = buildLogger(stream);

    log.info({ event_id: "evt_1" }, "processing event");

    const rec = JSON.parse(lines[0]);
    expect("error_type" in rec).toBe(false);
    expect("error_message" in rec).toBe(false);
  });

  it("never emits a SUCCESS severity — success is INFO plus app_event", () => {
    const { lines, stream } = capture();
    const log = buildLogger(stream);

    log.info({ app_event: "event_processing_succeeded" }, "processed event");

    const rec = JSON.parse(lines[0]);
    expect(rec.severity_text).toBe("INFO");
    expect(rec.app_event).toBe("event_processing_succeeded");
  });

  describe("record log context", () => {
    it("merges the active context into every line", async () => {
      const { lines, stream } = capture();
      const log = buildLogger(stream);

      await runWithLogContext({ event_id: "evt_1", type: "USER_CREATED" }, async () => {
        log.info("in context");
      });

      const rec = JSON.parse(lines[0]);
      expect(rec.event_id).toBe("evt_1");
      expect(rec.type).toBe("USER_CREATED");
      expect(rec.message).toBe("in context");
    });

    it("OMITS unknown context fields rather than emitting them as null", async () => {
      const { lines, stream } = capture();
      const log = buildLogger(stream);

      await runWithLogContext({ event_id: "evt_1" }, async () => {
        log.info("partial");
      });

      const rec = JSON.parse(lines[0]);
      expect(rec.event_id).toBe("evt_1");
      // `in`, not a truthiness check: the failure being guarded against is the
      // KEY existing with a null value, which reads as "resolved to null"
      // instead of "not applicable to this line".
      expect("order_id" in rec).toBe(false);
      expect("user_id" in rec).toBe(false);
      expect("source" in rec).toBe(false);
      expect("message_id" in rec).toBe(false);
    });

    it("emits no context fields outside a record", () => {
      const { lines, stream } = capture();
      const log = buildLogger(stream);

      log.info("outside");

      const rec = JSON.parse(lines[0]);
      expect("event_id" in rec).toBe(false);
      expect(rec.service_name).toBe("events-pipeline");
    });

    it("picks up fields added mid-record via setLogContext", async () => {
      const { lines, stream } = capture();
      const log = buildLogger(stream);

      await runWithLogContext({ event_id: "evt_1" }, async () => {
        setLogContext({ order_id: "ord_late" });
        log.info("after enrichment");
      });

      expect(JSON.parse(lines[0]).order_id).toBe("ord_late");
    });

    it("lets an explicit call-site field WIN over the context", async () => {
      const { lines, stream } = capture();
      const log = buildLogger(stream);

      await runWithLogContext({ type: "USER_CREATED" }, async () => {
        log.info({ type: "EXPLICIT" }, "override");
      });

      expect(JSON.parse(lines[0]).type).toBe("EXPLICIT");
    });

    it("still promotes err while carrying the context", async () => {
      class PermanentError extends Error {}
      const { lines, stream } = capture();
      const log = buildLogger(stream);

      await runWithLogContext({ event_id: "evt_1" }, async () => {
        log.error({ err: new PermanentError("boom") }, "failed");
      });

      const rec = JSON.parse(lines[0]);
      expect(rec.event_id).toBe("evt_1");
      expect(rec.error_type).toBe("PermanentError");
      expect(rec.error_message).toBe("boom");
    });

    it("does not leak one record's context onto the next", async () => {
      const { lines, stream } = capture();
      const log = buildLogger(stream);

      await runWithLogContext({ event_id: "evt_a", order_id: "ord_a" }, async () => {
        log.info("first");
      });
      await runWithLogContext({ event_id: "evt_b" }, async () => {
        log.info("second");
      });

      const second = JSON.parse(lines[1]);
      expect(second.event_id).toBe("evt_b");
      expect("order_id" in second).toBe(false);
    });
  });
  describe("trace correlation", () => {
    it("stamps the ACTIVE span's trace_id and span_id onto the line", async () => {
      const { lines, stream } = capture();
      const log = buildLogger(stream);

      let expected: { traceId: string; spanId: string } | undefined;
      await pipelineTracer.startActiveSpan("process_record", async (span) => {
        expected = span.spanContext();
        log.info({ app_event: "event_processing_succeeded" }, "processed event");
        span.end();
      });

      const rec = JSON.parse(lines[0]);
      // Exact string equality with the span's own ids: the logs<->traces join is
      // a string match between OpenObserve and Jaeger, so anything reformatted
      // here matches nothing and reports no error.
      expect(rec.trace_id).toBe(expected!.traceId);
      expect(rec.span_id).toBe(expected!.spanId);
    });

    it("emits lowercase, zero-padded hex — 32 chars for the trace, 16 for the span", async () => {
      const { lines, stream } = capture();
      const log = buildLogger(stream);

      await pipelineTracer.startActiveSpan("process_record", async (span) => {
        log.info("processed event");
        span.end();
      });

      const rec = JSON.parse(lines[0]);
      // The shape Users, Orders and Tracking all emit. An uppercase or
      // unpadded id is a silent correlation failure, not an error.
      expect(rec.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(rec.span_id).toMatch(/^[0-9a-f]{16}$/);
    });

    it("OMITS both fields outside a span — never an all-zero id", () => {
      const { lines, stream } = capture();
      const log = buildLogger(stream);

      // Cold-start and module-load lines run with no active span. Writing
      // trace_id: "000…0" would read as a real id and make every uncorrelated
      // line in the fleet appear to share one trace.
      log.info({ app_event: "event_processing_started" }, "processing event");

      const rec = JSON.parse(lines[0]);
      expect("trace_id" in rec).toBe(false);
      expect("span_id" in rec).toBe(false);
    });

    it("tracks the INNERMOST span, so a nested client span logs its own id", async () => {
      const { lines, stream } = capture();
      const log = buildLogger(stream);

      // Why the ids are read per line rather than stashed in the ALS store when
      // the record span opens: a line emitted from inside `ses SendEmail` must
      // carry THAT span's id, not the record's.
      await pipelineTracer.startActiveSpan("process_record", async (outer) => {
        await pipelineTracer.startActiveSpan("ses SendEmail", async (inner) => {
          log.info("sent email");
          inner.end();
        });
        expect(JSON.parse(lines[0]).span_id).not.toBe(outer.spanContext().spanId);
        outer.end();
      });
    });

    it("lets an explicit call-site trace_id win over the ambient one", async () => {
      const { lines, stream } = capture();
      const log = buildLogger(stream);

      // Same precedence rule the record context already follows: the call site
      // is the most specific source and beats ambient enrichment.
      await pipelineTracer.startActiveSpan("process_record", async (span) => {
        log.info({ trace_id: "explicit" }, "processed event");
        span.end();
      });

      expect(JSON.parse(lines[0]).trace_id).toBe("explicit");
    });
  });
});
