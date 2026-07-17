import type { LoggerOptions } from "pino";

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
    },
  };
}
