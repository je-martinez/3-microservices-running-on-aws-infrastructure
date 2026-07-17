import { describe, it, expect } from "vitest";
import pino from "pino";
import { buildLoggerOptions, SEVERITY_NUMBER } from "#shared/logging/logger";

function capture(): { lines: string[]; stream: { write: (s: string) => void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => lines.push(s) } };
}

describe("buildLoggerOptions", () => {
  it("emits the snake_case OTel-aligned schema", () => {
    const { lines, stream } = capture();
    const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
    log.info({ trace_id: "req-1" }, "request completed");
    const rec = JSON.parse(lines[0]);
    expect(rec.severity_text).toBe("INFO");
    expect(rec.severity_number).toBe(SEVERITY_NUMBER.INFO);
    expect(rec.service_name).toBe("users");
    expect(rec.deployment_environment).toBe("local");
    expect(rec.message).toBe("request completed");
    expect(rec.trace_id).toBe("req-1");
    expect(rec.timestamp).toBeDefined();
    expect(rec.level).toBeUndefined();
    expect(rec.msg).toBeUndefined();
  });

  it("maps error severity number", () => {
    const { lines, stream } = capture();
    const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
    log.error({ error_type: "ValidationError" }, "boom");
    const rec = JSON.parse(lines[0]);
    expect(rec.severity_text).toBe("ERROR");
    expect(rec.severity_number).toBe(17);
  });
});
