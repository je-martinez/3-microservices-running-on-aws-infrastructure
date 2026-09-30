import type { LoggerOptions } from "pino";
import { trace } from "@opentelemetry/api";
import { getLogContext } from "./log-context.ts";
import { redactWebhookToken } from "../observability/redact-webhook-token.ts";

const STRIPE_REDACTED = "[redacted: Stripe error text]";

/** A Stripe SDK error, recognised by shape so the logger need not import the SDK. */
type StripeShapedError = { constructor?: { name?: string }; code?: string; message?: string };

// WARNING: Match on CONSTRUCTOR name, never `err.name` — the Stripe SDK leaves
// `name` as the inherited "Error" and carries the real type only on the
// constructor. Measured: `new Stripe.errors.StripeInvalidRequestError(...).name`
// is "Error", so a check on `name` silently matches nothing and the redaction
// below never fires.
function isStripeError(err: unknown): err is StripeShapedError {
  if (typeof err !== "object" || err === null) return false;
  const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof ctor === "string" && ctor.startsWith("Stripe");
}

type SerializableRequest = {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
};

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
    // Fastify merges this over its default `req` serializer, which writes the
    // raw URL. See redactWebhookToken.
    serializers: {
      req: (req: SerializableRequest) => ({
        method: req.method,
        url: redactWebhookToken(req.url ?? ""),
        host: req.host,
        remoteAddress: req.ip,
        remotePort: req.socket?.remotePort,
      }),
    },
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

        const rawErr = (object_ as { err?: unknown }).err;
        // CONTRACT: A Stripe error's own text NEVER reaches a log line — its
        // auth errors embed a masked API key and its request errors embed other
        // customers' ids and a dashboard URL carrying the account id. Redacted
        // HERE and not in a `serializers.err`, because this formatter reads the
        // raw error first and would re-expose the message a serializer stripped.
        // The type and code diagnose the failure and carry no PII, so they stay.
        // See [[logging-context]]
        const err = isStripeError(rawErr)
          ? { type: rawErr.constructor?.name ?? "StripeError", code: rawErr.code, message: STRIPE_REDACTED, stack: "" }
          : rawErr;
        // Replace the field itself, not a local copy: pino emits `err` from the
        // object it is handed, so leaving the original in place keeps the
        // message AND the stack (which repeats it) on the line.
        if (err !== rawErr) Object.assign(object_, { err });
        if (err && typeof err === "object") {
          const errObj = err as {
            constructor?: { name?: string };
            type?: string;
            name?: string;
            message?: string;
          };
          return {
            ...object_,
            // `type` first: a redacted Stripe error is a PLAIN object whose constructor
            // is Object, and its own `type` carries the class name it came from.
            error_type: errObj.type ?? errObj.constructor?.name ?? errObj.name ?? "Error",
            error_message: errObj.message ?? "",
          };
        }
        return object_;
      },
    },
  };
}
