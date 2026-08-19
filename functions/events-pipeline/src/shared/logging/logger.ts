import type { LoggerOptions } from "pino";
import { trace } from "@opentelemetry/api";
import { getLogContext } from "#shared/logging/log-context";

// The active span's ids, ready to spread onto a log record — or nothing.
//
// WHY THIS IS WRITTEN BY HAND HERE, unlike in Users. Users gets `trace_id` for
// free from @opentelemetry/instrumentation-pino, which patches pino at
// require() time. This Lambda is ONE esbuild CJS bundle with pino inlined
// (scripts/build.mjs), so there is no module boundary left to patch: the
// instrumentation would load, patch nothing, and every line would ship without
// a trace id — silently, the failure mode that already cost this repo three
// incidents ([[logging-context]]). Stamping the ids in the formatter is the
// only mechanism that survives bundling.
//
// TWO RULES, both copied from Tracking's TraceContextFilter, and both about the
// same thing — the logs<->traces join is STRING EQUALITY between OpenObserve
// and Jaeger, so a different shape matches nothing and reports no error:
//
// 1. Lowercase, zero-padded hex: 32 chars for the trace, 16 for the span. This
//    is what `spanContext()` already returns in JS (unlike Python's ints, which
//    Tracking has to format), so the value is passed through untouched — the
//    point of this note is that it must NOT be reformatted, uppercased or
//    truncated on its way out.
// 2. OMITTED, never zeroed. Outside a span — module load, a cold-start line,
//    anything before the batch span opens — `getActiveSpan()` is undefined or
//    reports the all-zero INVALID_SPAN_CONTEXT. Writing `trace_id: "000…0"`
//    would be worse than writing nothing: it reads as a real id, and every
//    uncorrelated line in the fleet would appear to share one trace.
//
// This is also why @opentelemetry/api is imported here rather than
// #shared/observability/tracing: the api package is INERT without a registered
// provider (it answers "no active span" and nothing else), so importing it
// costs the unit tests no SDK, no exporter and no open socket.
function activeTraceIds(): { trace_id?: string; span_id?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext === undefined || !trace.isSpanContextValid(spanContext)) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

// OTel severity numbers (logs data model). Kept identical to Users'
// shared/logging/logger.ts so a line from this Lambda and a line from Users are
// indistinguishable downstream — the whole point of the shared schema.
export const SEVERITY_NUMBER: Record<string, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

export function buildLoggerOptions(opts: {
  serviceName: string;
  environment: string;
}): LoggerOptions {
  return {
    base: {
      service_name: opts.serviceName,
      deployment_environment: opts.environment,
    },
    messageKey: "message",
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      // Drop Pino's default numeric level; emit OTel-aligned fields instead.
      level(label) {
        const severity = label.toUpperCase();
        return {
          severity_text: severity,
          severity_number: SEVERITY_NUMBER[severity] ?? SEVERITY_NUMBER.INFO,
        };
      },
      // Note: no `bindings` formatter — Pino only puts `pid`/`hostname` in
      // bindings when they are added via `base`, and here `base` is explicitly
      // set to just { service_name, deployment_environment }, so no stripping
      // is needed. A `bindings() { return {} }` formatter would replace `base`
      // entirely and drop service_name/deployment_environment.
      //
      // Promote `err` to top-level `error_type`/`error_message` so this matches
      // the shared OTel-aligned schema (and the Orders service).
      // `serializers.err` can only replace the nested `err` value, not add
      // top-level keys, so this has to happen here in `formatters.log`. Note
      // `formatters.log` runs BEFORE Pino's own `err` serializer, so
      // `object.err` is still the raw Error instance here —
      // `err.constructor.name` gives the concrete error class (e.g.
      // "TransientError"), unlike `err.name`/`err.type`, which are "Error"
      // unless the class overrides them. We still fall back to `type`/`name` to
      // support an already-serialized err object (e.g. a plain
      // `{ type, message }` passed directly instead of an Error instance). The
      // nested `err` (with its stack) is left in place — only added to, never
      // removed. Non-error logs are untouched: no `err`, no
      // `error_type`/`error_message`.
      //
      // CAUTION for this service: `err` puts the error's MESSAGE in the record.
      // Mongo driver errors and Zod parse errors echo the rejected document /
      // raw body, which carry the event payload — never pass those as `err`
      // (see the sanitization in src/handler.ts).
      log(object) {
        // Ambient enrichment first, explicit call-site fields last: a field
        // passed at the call site always wins over the context. Unknown context
        // fields are simply absent from the store, so nothing null is emitted
        // (see #shared/logging/log-context).
        //
        // The span ids go FIRST, ahead of the record context, for the same
        // precedence reason: they are the most ambient thing on the line.
        const object_ = { ...activeTraceIds(), ...getLogContext(), ...object } as typeof object;

        const err = (object_ as { err?: unknown }).err;
        if (err && typeof err === "object") {
          const errObj = err as {
            constructor?: { name?: string };
            type?: string;
            name?: string;
            message?: string;
          };
          return {
            ...object_,
            error_type: errObj.constructor?.name ?? errObj.type ?? errObj.name ?? "Error",
            error_message: errObj.message ?? "",
          };
        }
        return object_;
      },
    },
  };
}
