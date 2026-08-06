import pino from "pino";

// Matches the events-pipeline's logger so both packages emit the same shape.
// Never log a token, a plaintext email, or a full payload — see the
// logging-context convention.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "realtime-events" },
});
