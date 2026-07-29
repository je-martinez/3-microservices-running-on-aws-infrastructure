import type { LoggerOptions } from "pino";
import { getLogContext } from "./log-context.ts";

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
      // Note: no `bindings` formatter — Pino only puts `pid`/`hostname` in bindings
      // when they are added via `base`, and here `base` is explicitly set to just
      // { service_name, deployment_environment }, so no stripping is needed. A
      // `bindings() { return {} }` formatter would replace `base` entirely and drop
      // service_name/deployment_environment (verified against pino@10.3.1).
      //
      // Promote `err` to top-level `error_type`/`error_message` so this matches
      // the shared OTel-aligned schema (and the Orders service). `serializers.err`
      // can only replace the nested `err` value, not add top-level keys, so this
      // has to happen here in `formatters.log`. Note `formatters.log` runs BEFORE
      // Pino's own `err` serializer, so `object.err` is still the raw Error
      // instance here — `err.constructor.name` gives the concrete error class
      // (e.g. "NoMatchingUserError"), unlike `err.name`/`err.type`, which are
      // "Error" unless the class overrides them. We still fall back to
      // `type`/`name` to support an already-serialized err object (e.g. a plain
      // `{ type, message }` passed directly instead of an Error instance). The
      // nested `err` (with its stack) is left in place — only added to, never
      // removed — so existing consumers of `err` keep working. Non-error logs
      // are untouched: no `err`, no `error_type`/`error_message`.
      log(object) {
        // Ambient request context first, explicit call-site fields second: a
        // field passed at the call site always wins over the context. Unknown
        // context fields are simply absent from the store, so nothing null is
        // emitted (see shared/logging/log-context.ts).
        const object_ = { ...getLogContext(), ...object } as typeof object;

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
