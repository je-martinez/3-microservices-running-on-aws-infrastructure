import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { VerifyOtpChallengeCommand } from "#features/users/commands/verify-otp-challenge";
import { testSpanExporter } from "../../../setup-tracing.ts";
import { InvalidOtpError } from "#shared/auth/auth-errors";

const TOKENS = { idToken: "id1", accessToken: "acc1", refreshToken: "rt1" };

function deps(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      respondToOtpChallenge: vi.fn(async () => TOKENS),
      ...overrides,
    },
  } as any;
}

describe("VerifyOtpChallengeCommand", () => {
  it("returns AuthTokens on a correct code", async () => {
    const command = new VerifyOtpChallengeCommand(deps());
    const result = await command.execute({ email: "a@b.co", session: "sess_1", code: "042817" });
    expect(result).toEqual(TOKENS);
  });

  it("passes email, session and code through to the auth provider in that order", async () => {
    const d = deps();
    const command = new VerifyOtpChallengeCommand(d);
    await command.execute({ email: "a@b.co", session: "sess_1", code: "042817" });
    expect(d.auth.respondToOtpChallenge).toHaveBeenCalledWith("a@b.co", "sess_1", "042817");
  });

  it("rethrows InvalidOtpError untouched on an incorrect code", async () => {
    const command = new VerifyOtpChallengeCommand(
      deps({
        respondToOtpChallenge: vi.fn(async () => {
          throw new InvalidOtpError();
        }),
      }),
    );
    const err = await command
      .execute({ email: "a@b.co", session: "sess_1", code: "000000" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidOtpError);
    // The 401 invalid_otp HTTP contract comes straight off this error.
    expect((err as InvalidOtpError).statusCode).toBe(401);
    expect((err as InvalidOtpError).code).toBe("invalid_otp");
  });

  // THE constraint of this feature: a 6-digit code has only 1,000,000
  // possibilities, so no masked/hashed/truncated form of it is safe to log.
  // Serializing every captured log call catches the code hiding in ANY nested
  // field, including inside an error object's message.
  it("never logs the submitted code — on the success path", async () => {
    const { appLogger } = await import("#shared/logging/app-logger");
    const calls: unknown[] = [];
    const infoSpy = vi.spyOn(appLogger, "info").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);

    const command = new VerifyOtpChallengeCommand(deps());
    await command.execute({ email: "a@b.co", session: "sess_1", code: "042817" });

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("042817");
    expect(serialized).not.toContain("sess_1");

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("never logs the submitted code — on the failure path", async () => {
    const { appLogger } = await import("#shared/logging/app-logger");
    const calls: unknown[] = [];
    const infoSpy = vi.spyOn(appLogger, "info").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);

    const command = new VerifyOtpChallengeCommand(
      deps({
        respondToOtpChallenge: vi.fn(async () => {
          throw new InvalidOtpError();
        }),
      }),
    );
    await command
      .execute({ email: "a@b.co", session: "sess_1", code: "999123" })
      .catch(() => undefined);

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("999123");
    expect(serialized).not.toContain("sess_1");

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs reason invalid_otp for a wrong code and cognito_error otherwise", async () => {
    const { appLogger } = await import("#shared/logging/app-logger");
    const calls: unknown[] = [];
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);

    await new VerifyOtpChallengeCommand(
      deps({ respondToOtpChallenge: vi.fn(async () => { throw new InvalidOtpError(); }) }),
    )
      .execute({ email: "a@b.co", session: "s", code: "000000" })
      .catch(() => undefined);

    await new VerifyOtpChallengeCommand(
      deps({ respondToOtpChallenge: vi.fn(async () => { throw new Error("cognito down"); }) }),
    )
      .execute({ email: "a@b.co", session: "s", code: "000000" })
      .catch(() => undefined);

    errorSpy.mockRestore();

    const reasons = calls.map((c) => (c as [Record<string, unknown>])[0].reason);
    expect(reasons).toEqual(["invalid_otp", "cognito_error"]);
  });
});

describe("VerifyOtpChallengeCommand tracing", () => {
  beforeEach(() => testSpanExporter.reset());

  it("emits an 'otp_verify' span with app_event=otp_verify_succeeded on success", async () => {
    await new VerifyOtpChallengeCommand(deps()).execute({
      email: "a@b.co",
      session: "sess_1",
      code: "042817",
    });

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "otp_verify");
    expect(span).toBeDefined();
    expect(span!.attributes.app_event).toBe("otp_verify_succeeded");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  it("emits an 'otp_verify' span with ERROR status and reason=invalid_otp on a wrong code", async () => {
    const command = new VerifyOtpChallengeCommand(
      deps({
        respondToOtpChallenge: vi.fn(async () => {
          throw new InvalidOtpError();
        }),
      }),
    );

    await expect(
      command.execute({ email: "a@b.co", session: "sess_1", code: "000000" }),
    ).rejects.toBeInstanceOf(InvalidOtpError);

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "otp_verify");
    expect(span!.ended).toBe(true);
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes.app_event).toBe("otp_verify_failed");
    // The reason names the CLASS of failure only — never the code itself.
    expect(span!.attributes.reason).toBe("invalid_otp");
  });

  // THE constraint of this feature, restated for spans: a span is exported to a
  // backend exactly like a log line, so a 6-digit code — 1,000,000
  // possibilities, live for its whole TTL — must never reach one in ANY form.
  // Serializing the whole attribute bag catches it hiding in any field.
  it("never puts the submitted code or session on the span — success path", async () => {
    await new VerifyOtpChallengeCommand(deps()).execute({
      email: "ada@example.com",
      session: "sess_1",
      code: "042817",
    });

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "otp_verify");
    const serialized = JSON.stringify(span!.attributes);
    expect(serialized).not.toContain("042817");
    expect(serialized).not.toContain("sess_1");
    expect(serialized).not.toContain("ada@example.com");
    expect(span!.attributes.email_hash).toBeDefined();
  });

  it("never puts the submitted code or session on the span — failure path", async () => {
    const command = new VerifyOtpChallengeCommand(
      deps({
        respondToOtpChallenge: vi.fn(async () => {
          throw new InvalidOtpError();
        }),
      }),
    );

    await command
      .execute({ email: "ada@example.com", session: "sess_1", code: "999123" })
      .catch(() => undefined);

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "otp_verify");
    const serialized = JSON.stringify(span!.attributes);
    expect(serialized).not.toContain("999123");
    expect(serialized).not.toContain("sess_1");
    expect(serialized).not.toContain("ada@example.com");
  });
});
