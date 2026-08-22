import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { ForgotPasswordCommand } from "#features/users/commands/forgot-password";
import { testSpanExporter } from "../../../setup-tracing.ts";
import { RESET_CODE_TTL_SECONDS } from "#shared/auth/reset-code";

const EMAIL = "jose@example.com";

const USER = {
  id: "usr_1",
  email: EMAIL,
  fullName: "Jose",
  cognitoSub: "sub-1",
};

function build(overrides: { user?: unknown; publishRejects?: boolean } = {}) {
  const db = {
    user: { findFirst: vi.fn(async () => ("user" in overrides ? overrides.user : USER)) },
  };
  const events = {
    publishPasswordResetRequested: vi.fn(async () => {
      if (overrides.publishRejects) throw new Error("sqs down");
    }),
  };
  const resetCodeStore = { store: vi.fn(async () => undefined) };

  const command = new ForgotPasswordCommand({
    db: db as never,
    events: events as never,
    resetCodeStore: resetCodeStore as never,
  });

  return { command, db, events, resetCodeStore };
}

beforeEach(() => vi.clearAllMocks());

describe("ForgotPasswordCommand", () => {
  it("stores a 6-digit code in the reset-code store for a known email", async () => {
    const { command, resetCodeStore } = build();

    await command.execute({ email: EMAIL });

    expect(resetCodeStore.store).toHaveBeenCalledTimes(1);
    const [email, code] = resetCodeStore.store.mock.calls[0]!;
    expect(email).toBe(EMAIL);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("publishes PASSWORD_RESET_REQUESTED with the SAME code it stored", async () => {
    const { command, resetCodeStore, events } = build();

    await command.execute({ email: EMAIL });

    const [, storedCode] = resetCodeStore.store.mock.calls[0]!;
    // The code the user receives by email must be the one that will verify.
    // Two independently generated codes would pass a per-side test each and
    // still make every reset fail for real users.
    expect(events.publishPasswordResetRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        email: EMAIL,
        fullName: "Jose",
        code: storedCode,
        ttlSeconds: RESET_CODE_TTL_SECONDS,
      }),
    );
  });

  // ==== NO USER ENUMERATION ====
  // These two are the security property of the endpoint, not incidental cases:
  // an unknown email must be indistinguishable from a known one to the caller.
  it("resolves silently for an unknown email (no throw)", async () => {
    const { command } = build({ user: null });
    await expect(command.execute({ email: "nobody@example.com" })).resolves.toBeUndefined();
  });

  it("mints, stores and publishes NOTHING for an unknown email", async () => {
    const { command, resetCodeStore, events } = build({ user: null });

    await command.execute({ email: "nobody@example.com" });

    expect(resetCodeStore.store).not.toHaveBeenCalled();
    expect(events.publishPasswordResetRequested).not.toHaveBeenCalled();
  });

  it("swallows a publish failure (best-effort, never rethrown)", async () => {
    // A rethrow here would surface a 500 ONLY for emails that exist — which is
    // itself the enumeration oracle the flow avoids everywhere else.
    const { command, resetCodeStore } = build({ publishRejects: true });

    await expect(command.execute({ email: EMAIL })).resolves.toBeUndefined();
    expect(resetCodeStore.store).toHaveBeenCalledTimes(1);
  });
});

describe("ForgotPasswordCommand tracing", () => {
  beforeEach(() => testSpanExporter.reset());

  it("emits a 'password_reset_requested' span with password_reset_requested_succeeded for a known email", async () => {
    const { command } = build();

    await command.execute({ email: EMAIL });

    const span = testSpanExporter
      .getFinishedSpans()
      .find((s) => s.name === "password_reset_requested");
    expect(span).toBeDefined();
    expect(span!.attributes.app_event).toBe("password_reset_requested_succeeded");
    expect(span!.attributes.user_id).toBe("usr_1");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  // ==== NO USER ENUMERATION, IN THE TRACE BACKEND TOO ====
  // The unknown-email branch is a SUCCESS with reason=unknown_email in the log,
  // and the span says exactly the same. An ERROR span here would rebuild the
  // oracle the endpoint refuses to be, just somewhere else.
  it("marks an unknown email as a success with reason=unknown_email, matching the log", async () => {
    const { command } = build({ user: null });

    await command.execute({ email: "nobody@example.com" });

    const span = testSpanExporter
      .getFinishedSpans()
      .find((s) => s.name === "password_reset_requested");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
    expect(span!.attributes.app_event).toBe("password_reset_requested_succeeded");
    expect(span!.attributes.reason).toBe("unknown_email");
  });

  it("emits an ERROR span when the flow throws, with the span closed", async () => {
    // The publish failure is deliberately swallowed, so the error path is
    // reached through the store instead — what is asserted is that the span
    // still closes and reports ERROR when something does escape.
    const { command, resetCodeStore } = build();
    resetCodeStore.store.mockRejectedValueOnce(new Error("redis down"));

    await expect(command.execute({ email: EMAIL })).rejects.toThrow("redis down");

    const span = testSpanExporter
      .getFinishedSpans()
      .find((s) => s.name === "password_reset_requested");
    expect(span!.ended).toBe(true);
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("never puts the minted code or the plaintext email on the span", async () => {
    const { command, resetCodeStore } = build();

    await command.execute({ email: EMAIL });

    const [, code] = resetCodeStore.store.mock.calls[0]!;
    const span = testSpanExporter
      .getFinishedSpans()
      .find((s) => s.name === "password_reset_requested");
    const serialized = JSON.stringify(span!.attributes);
    expect(serialized).not.toContain(code as string);
    expect(serialized).not.toContain(EMAIL);
    expect(span!.attributes.email_hash).toBeDefined();
  });
});
