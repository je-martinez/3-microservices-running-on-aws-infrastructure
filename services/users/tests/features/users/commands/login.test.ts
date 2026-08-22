import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { LoginUserCommand } from "#features/users/commands/login";
import { testSpanExporter } from "../../../setup-tracing.ts";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";
import { appLogger } from "#shared/logging/app-logger";

const TOKENS = { idToken: "id1", accessToken: "acc1", refreshToken: "rt1" };

function deps(overrides: Record<string, unknown> = {}) {
  return {
    auth: { login: vi.fn(async () => TOKENS) },
    db: { user: { findUnique: vi.fn(async () => ({ authType: "PASSWORD" })) } },
    ...overrides,
  } as any;
}

describe("LoginUserCommand", () => {
  it("returns AuthTokens for a PASSWORD user with correct credentials", async () => {
    const tokens = await new LoginUserCommand(deps()).execute({ email: "a@b.co", password: "x" });
    expect(tokens).toEqual(TOKENS);
  });

  it("rejects a PASSWORDLESS user with generic 401 invalid_credentials, before calling Cognito", async () => {
    const d = deps({
      db: { user: { findUnique: vi.fn(async () => ({ authType: "PASSWORDLESS" })) } },
    });
    const command = new LoginUserCommand(d);

    const err = await command.execute({ email: "a@b.co", password: "x" }).catch((e: unknown) => e);

    // NOT a 403: per auth-error-mapping's anti-enumeration rule the response
    // must be indistinguishable from a wrong password.
    expect(err).toBeInstanceOf(InvalidCredentialsError);
    expect((err as InvalidCredentialsError).statusCode).toBe(401);
    expect((err as InvalidCredentialsError).code).toBe("invalid_credentials");
    // The guard must short-circuit BEFORE any Cognito call — a passwordless
    // account's random password must never even be tried.
    expect(d.auth.login).not.toHaveBeenCalled();
  });

  it("logs reason: passwordless_user for the guard rejection, never a distinct status/code", async () => {
    const d = deps({
      db: { user: { findUnique: vi.fn(async () => ({ authType: "PASSWORDLESS" })) } },
    });
    const calls: unknown[] = [];
    const spy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);

    await new LoginUserCommand(d).execute({ email: "a@b.co", password: "x" }).catch(() => undefined);

    spy.mockRestore();
    const [fields] = calls[0] as [Record<string, unknown>];
    expect(fields.app_event).toBe("login_failed");
    expect(fields.reason).toBe("passwordless_user");
    // The password never reaches a log line, guard path included.
    expect(JSON.stringify(calls)).not.toContain('"x"');
  });

  it("still rejects with invalid_credentials when no user row exists for the email", async () => {
    const d = deps({ db: { user: { findUnique: vi.fn(async () => null) } } });
    // No local row is not itself a passwordless rejection — Cognito is still
    // asked, and IT returns the usual invalid-credentials rejection.
    d.auth.login = vi.fn(async () => {
      throw new InvalidCredentialsError();
    });
    await expect(
      new LoginUserCommand(d).execute({ email: "nouser@b.co", password: "x" }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(d.auth.login).toHaveBeenCalledOnce();
  });

  it("looks the user up by email exactly once per login", async () => {
    const d = deps();
    await new LoginUserCommand(d).execute({ email: "a@b.co", password: "x" });
    expect(d.db.user.findUnique).toHaveBeenCalledWith({ where: { email: "a@b.co" } });
  });
});

describe("LoginUserCommand tracing", () => {
  beforeEach(() => testSpanExporter.reset());

  it("emits a 'login' span with app_event=login_succeeded on success", async () => {
    await new LoginUserCommand(deps()).execute({ email: "a@b.co", password: "x" });

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "login");
    expect(span).toBeDefined();
    expect(span!.attributes.app_event).toBe("login_succeeded");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  it("emits a 'login' span with ERROR status and reason=invalid_credentials on a bad password", async () => {
    const d = deps();
    d.auth.login = vi.fn(async () => {
      throw new InvalidCredentialsError();
    });

    await expect(
      new LoginUserCommand(d).execute({ email: "a@b.co", password: "wrong" }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "login");
    expect(span!.ended).toBe(true);
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes.app_event).toBe("login_failed");
    expect(span!.attributes.reason).toBe("invalid_credentials");
  });

  it("carries reason=passwordless_user on the span for the guard rejection, matching the log", async () => {
    // The response stays the generic 401; the real cause is operator-only, in
    // the log AND now on the span — the two must not disagree.
    const d = deps({
      db: { user: { findUnique: vi.fn(async () => ({ authType: "PASSWORDLESS" })) } },
    });

    await new LoginUserCommand(d).execute({ email: "a@b.co", password: "x" }).catch(() => undefined);

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "login");
    expect(span!.attributes.reason).toBe("passwordless_user");
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("never puts the plaintext email or the password on the span", async () => {
    await new LoginUserCommand(deps()).execute({ email: "ada@example.com", password: "Sup3rS3cret!" });

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "login");
    const serialized = JSON.stringify(span!.attributes);
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("Sup3rS3cret!");
    expect(span!.attributes.email_hash).toBeDefined();
  });
});
