import type { LoggerOptions } from "pino";
import { trace } from "@opentelemetry/api";
import { getLogContext } from "./log-context.ts";

// CONTRACT: Active span IDs must format as lowercase hex (32-char trace_id, 16-char span_id).
// Omit keys when no active span exists (never emit all-zeros or nulls).
// See [[logging-context]]
function activeTraceIds(): { trace_id?: string; span_id?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext === undefined || !trace.isSpanContextValid(spanContext)) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

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
      // CONTRACT: Promote err to top-level error_type and error_message to match shared OTel schema.
      // Do NOT replace base bindings with bindings() => ({}) as that drops service_name.
      // See [[logging-context]]
      log(object) {
        // Span IDs and ambient context are spread before explicit call-site fields.
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
