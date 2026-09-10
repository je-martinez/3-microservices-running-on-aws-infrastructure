import type { LoggerOptions } from "pino";
import { trace } from "@opentelemetry/api";
import { getLogContext } from "#shared/logging/log-context";

// CONTRACT: Do NOT replace this with @opentelemetry/instrumentation-pino. This
// Lambda is one esbuild bundle with pino inlined, leaving no module boundary to
// patch — the instrumentation loads, patches nothing, and every line ships
// without a trace id, silently. The logs<->traces join is string equality, so
// the ids must go out as lowercase hex (32/16 chars, exactly what
// `spanContext()` returns) and be OMITTED outside a span, never zeroed: an
// all-zero id reads as real and makes every uncorrelated line share one trace.
// See [[logging-context]]

// WHY: @opentelemetry/api, not #shared/observability/tracing — the api package
// is inert without a registered provider, so unit tests pay no SDK, exporter or
// open socket for this import.
function activeTraceIds(): { trace_id?: string; span_id?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext === undefined || !trace.isSpanContextValid(spanContext)) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

// CONTRACT: OTel severity numbers, identical to Users' logger — a line from
// this Lambda and a line from Users must be indistinguishable downstream.
// See [[logging-context]]
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
      // CONTRACT: Do NOT add a `bindings` formatter — it replaces `base` and
      // drops service_name/deployment_environment. Promoting `err` to top-level
      // `error_type`/`error_message` must stay in `formatters.log`:
      // `serializers.err` can only replace the nested value, and this runs
      // before pino's serializer, so `object.err` is still the raw Error and
      // `err.constructor.name` gives the concrete class.
      // See [[logging-context]]

      // WARNING: PII. `err` puts the error's MESSAGE in the record, and Mongo
      // driver and Zod errors echo the rejected document or raw body — never
      // pass those as `err`; sanitize them in src/handler.ts first.
      log(object) {
        // CONTRACT: Keep this order — span ids, then record context, then
        // call-site fields. A call-site field must win over the context, and
        // unknown context fields are absent rather than null.
        // See [[logging-context]]
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
