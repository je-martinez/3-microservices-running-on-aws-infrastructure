import { describe, it, expect } from "vitest";
import pino from "pino";
import { buildLoggerOptions, SEVERITY_NUMBER } from "#shared/logging/logger";
import { runWithLogContext, setLogContext } from "#shared/logging/log-context";

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

  it("promotes err to top-level error_type/error_message, matching the shared schema", () => {
    class NoMatchingUserError extends Error {}
    const { lines, stream } = capture();
    const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
    log.error({ err: new NoMatchingUserError("boom") }, "failed");
    const rec = JSON.parse(lines[0]);
    expect(rec.error_type).toBe("NoMatchingUserError");
    expect(rec.error_message).toBe("boom");
  });

  it("does not add error_type/error_message to a normal log with no err", () => {
    const { lines, stream } = capture();
    const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
    log.info({ trace_id: "req-1" }, "request completed");
    const rec = JSON.parse(lines[0]);
    expect(rec.error_type).toBeUndefined();
    expect(rec.error_message).toBeUndefined();
  });

  describe("request log context", () => {
    it("merges the active context into every line", async () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      await runWithLogContext({ cognito_sub: "sub-1", user_id: "usr_1" }, async () => {
        log.info("in context");
      });

      const rec = JSON.parse(lines[0]);
      expect(rec.cognito_sub).toBe("sub-1");
      expect(rec.user_id).toBe("usr_1");
      expect(rec.message).toBe("in context");
    });

    it("omits unknown context fields rather than emitting null", async () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      await runWithLogContext({ cognito_sub: "sub-1" }, async () => {
        log.info("partial");
      });

      const rec = JSON.parse(lines[0]);
      expect(rec.cognito_sub).toBe("sub-1");
      expect("user_id" in rec).toBe(false);
      expect("email" in rec).toBe(false);
      expect("email_hash" in rec).toBe(false);
    });

    it("picks up fields added mid-request", async () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      await runWithLogContext({ cognito_sub: "sub-1" }, async () => {
        setLogContext({ user_id: "usr_late" });
        log.info("after enrichment");
      });

      expect(JSON.parse(lines[0]).user_id).toBe("usr_late");
    });

    it("emits no context fields outside a request", () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      log.info("outside");

      const rec = JSON.parse(lines[0]);
      expect("cognito_sub" in rec).toBe(false);
      expect(rec.service_name).toBe("users");
    });

    it("lets an explicit call-site field win over the context", async () => {
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      await runWithLogContext({ order_id: "ord_ctx" }, async () => {
        log.info({ order_id: "ord_explicit" }, "override");
      });

      expect(JSON.parse(lines[0]).order_id).toBe("ord_explicit");
    });

    it("still promotes err while carrying the context", async () => {
      class CognitoError extends Error {}
      const { lines, stream } = capture();
      const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);

      await runWithLogContext({ cognito_sub: "sub-1" }, async () => {
        log.error({ err: new CognitoError("boom") }, "failed");
      });

      const rec = JSON.parse(lines[0]);
      expect(rec.cognito_sub).toBe("sub-1");
      expect(rec.error_type).toBe("CognitoError");
      expect(rec.error_message).toBe("boom");
    });
  });
});
