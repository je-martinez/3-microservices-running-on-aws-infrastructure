import pino from "pino";

// OTel severity numbers (logs data model). Kept identical to the
// events-pipeline's and Users' tables so a line from this Lambda and a line
// from any service are indistinguishable downstream — the whole point of the
// shared schema ([[logging-context]]).
const SEVERITY_NUMBER: Record<string, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

// WARNING: PII. Never log a token, a plaintext email, or a full payload.

// CONTRACT: Keep the formatters, and keep them HERE in the producer. Pino's
// default `level: 30` is its own scale, which nothing downstream reads — every
// line then lands at severity 0 (UNSPECIFIED) and a genuine WARN filters
// identically to an INFO. A collector-side mapping would leave this Lambda
// emitting a schema-violating value for anyone reading the raw CloudWatch
// stream. The key is `service_name`, never `service`, or the dashboards group by
// a field these records do not carry and the lines are unattributable.
// See [[logging-context]]
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    service_name: "realtime-events",
    deployment_environment: process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
  },
  formatters: {
    // Replaces Pino's numeric `level` with the OTel pair. Returning an object
    // without `level` is what drops the original field rather than emitting
    // both.
    level(label) {
      const severity = label.toUpperCase();
      return {
        severity_text: severity,
        severity_number: SEVERITY_NUMBER[severity] ?? SEVERITY_NUMBER.INFO,
      };
    },
  },
  // Pino writes its own `time` in ms; the schema uses an ISO-8601 `timestamp`,
  // which is what every other producer emits and what a human reads in the UI.
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
});
