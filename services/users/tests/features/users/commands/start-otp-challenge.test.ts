import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { StartOtpChallengeCommand } from "#features/users/commands/start-otp-challenge";
import { testSpanExporter } from "../../../setup-tracing.ts";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";

function deps(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      startOtpChallenge: vi.fn(async () => ({ session: "sess_abc" })),
      ...overrides,
    },
  } as any;
}

describe("StartOtpChallengeCommand", () => {
  it("returns the session from the auth provider", async () => {
    const command = new StartOtpChallengeCommand(deps());
    const result = await command.execute({ email: "a@b.co" });
    expect(result).toEqual({ session: "sess_abc" });
  });

  it("passes the email through to the auth provider", async () => {
    const d = deps();
    const command = new StartOtpChallengeCommand(d);
    await command.execute({ email: "a@b.co" });
    expect(d.auth.startOtpChallenge).toHaveBeenCalledWith("a@b.co");
  });

  it("propagates the auth provider's error untouched", async () => {
    const command = new StartOtpChallengeCommand(
      deps({
        startOtpChallenge: vi.fn(async () => {
          throw new Error("cognito down");
        }),
      }),
    );
    await expect(command.execute({ email: "a@b.co" })).rejects.toThrow("cognito down");
  });

  // An unknown email surfaces as the generic invalid-credentials error, not a
  // distinct "no such user" — the HTTP contract must not confirm existence.
  it("rethrows InvalidCredentialsError untouched for an unknown user", async () => {
    const command = new StartOtpChallengeCommand(
      deps({
        startOtpChallenge: vi.fn(async () => {
          throw new InvalidCredentialsError();
        }),
      }),
    );
    await expect(command.execute({ email: "ghost@b.co" })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  // The session is what respondToOtpChallenge trades for real tokens, so it is
  // credential-adjacent and must never reach a log line.
  it("never logs the returned session", async () => {
    const { appLogger } = await import("#shared/logging/app-logger");
    const calls: unknown[] = [];
    const infoSpy = vi.spyOn(appLogger, "info").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);

    const command = new StartOtpChallengeCommand(deps());
    await command.execute({ email: "a@b.co" });

    expect(JSON.stringify(calls)).not.toContain("sess_abc");

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("StartOtpChallengeCommand tracing", () => {
  beforeEach(() => testSpanExporter.reset());

  it("emits an 'otp_challenge' span with app_event=otp_challenge_succeeded on success", async () => {
    await new StartOtpChallengeCommand(deps()).execute({ email: "a@b.co" });

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "otp_challenge");
    expect(span).toBeDefined();
    expect(span!.attributes.app_event).toBe("otp_challenge_succeeded");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  it("emits an 'otp_challenge' span with ERROR status and reason=cognito_error on failure", async () => {
    const command = new StartOtpChallengeCommand(
      deps({
        startOtpChallenge: vi.fn(async () => {
          throw new Error("cognito down");
        }),
      }),
    );

    await expect(command.execute({ email: "a@b.co" })).rejects.toThrow("cognito down");

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "otp_challenge");
    expect(span!.ended).toBe(true);
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes.app_event).toBe("otp_challenge_failed");
    expect(span!.attributes.reason).toBe("cognito_error");
  });

  it("never puts the session or the plaintext email on the span", async () => {
    // The session buys tokens, so it is credential-adjacent — no more loggable
    // as a span attribute than as a log field.
    await new StartOtpChallengeCommand(deps()).execute({ email: "ada@example.com" });

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "otp_challenge");
    const serialized = JSON.stringify(span!.attributes);
    expect(serialized).not.toContain("sess_abc");
    expect(serialized).not.toContain("ada@example.com");
    expect(span!.attributes.email_hash).toBeDefined();
  });
});
