import { describe, expect, it } from "vitest";
import pino from "pino";
import Stripe from "stripe";
import { buildLoggerOptions } from "#shared/logging/logger";

/**
 * CONTRACT: Stripe's own error text never reaches a log line — services/users
 * CLAUDE.md §7. Its auth errors embed a masked API key and its request errors
 * embed other customers' ids and a dashboard URL carrying the account id.
 */
describe("the logger's Stripe error redaction", () => {
  function logged(err: unknown): Record<string, unknown> {
    const lines: string[] = [];
    const logger = pino(buildLoggerOptions({ serviceName: "users", environment: "test" }), {
      write: (s: string) => lines.push(s),
    });
    logger.error({ err }, "probe");
    return JSON.parse(lines.find((l) => l.includes("probe"))!) as Record<string, unknown>;
  }

  it("replaces a Stripe error's message, keeping the type and code", () => {
    const err = new Stripe.errors.StripeInvalidRequestError({
      message:
        "The payment method you provided is not attached to a customer so detachment is impossible.",
      code: "resource_missing",
    });

    const line = logged(err);
    const serialized = JSON.stringify(line);

    expect(serialized).not.toContain("not attached to a customer");
    expect(serialized).not.toContain("dashboard.stripe.com");
    // `error_type` is the field the shared OTel schema queries on, and it keeps
    // the Stripe class name. `err.type` reads "Object" because redaction hands
    // pino a plain object — the class survives in error_type, not there.
    expect(line.error_type).toBe("StripeInvalidRequestError");
    expect(line.err).toMatchObject({ code: "resource_missing" });
    expect(line.error_message).toBe("[redacted: Stripe error text]");
  });

  it("leaves a non-Stripe error's message intact, since only Stripe's text is prohibited", () => {
    const line = logged(new Error("ordinary failure the operator needs to read"));
    expect(JSON.stringify(line)).toContain("ordinary failure the operator needs to read");
  });
});
