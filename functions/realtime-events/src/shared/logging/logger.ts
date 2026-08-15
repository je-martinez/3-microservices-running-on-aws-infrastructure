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

// Matches the events-pipeline's logger so both packages emit the same shape.
// Never log a token, a plaintext email, or a full payload — see the
// logging-context convention.
//
// WHY THE FORMATTERS. Pino's default emits `level: 30` — its own numeric scale,
// which nothing downstream reads. The shared schema is `severity_text` +
// `severity_number` (OTel's scale, where INFO is 9, not 30), and the collector
// promotes those onto the record's native severity fields. Without this, every
// line from this Lambda arrived in OpenObserve at severity 0 (UNSPECIFIED):
// measured at 53 such lines in an hour, including `ws_connect_denied` — a
// genuine WARN that was indistinguishable from an INFO on every dashboard and
// in every severity filter.
//
// The translation belongs HERE, in the producer, not in the collector. A
// mapping rule downstream would leave this Lambda emitting a value that
// violates the schema and hide it from anyone reading `docker logs` or the raw
// CloudWatch stream — two sources of truth for one contract.
//
// `service` also became `service_name`: the schema field every other producer
// uses, and what the dashboards group by. A line tagged `service` was invisible
// to a `service_name` filter, so this Lambda's records were unattributable.
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
