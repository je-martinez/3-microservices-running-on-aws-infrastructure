import { describe, it, expect, vi } from "vitest";
import { createContainer, asValue, asFunction, Lifetime } from "awilix";
import { buildApp } from "#features/users/http/routes";
import { UserQueryService } from "#features/users/queries/get-me";
import { getActor } from "#shared/audit/actor-context";
import { getLogContext, setLogContext } from "#shared/logging/log-context";
import { NoMatchingUserError } from "#features/users/webhooks/capture-cognito-identity";
import {
  InvalidCredentialsError,
  EmailAlreadyExistsError,
  InvalidOtpError,
  InvalidResetCodeError,
} from "#shared/auth/auth-errors";

// Full-shaped fixture matching the domain `User` type (see domain/user.ts):
// once routes carry a response schema, Fastify's Zod serializer strict-
// validates the handler's return value, so mocks must return every declared
// field, not just the ones a given test asserts on. `createdAt`/`updatedAt`
// are real `Date` objects here (as the domain type + real commands/queries
// return) — `routes.ts`'s `serializeUser` converts them to ISO strings at
// the HTTP boundary, matching `UserSchema`'s `z.string()` wire contract.
const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");

function fakeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "usr_1",
    email: "a@b.co",
    fullName: "A",
    address: null,
    phoneNumber: null,
    tags: [] as string[],
    authType: "PASSWORD" as const,
    mustChangePassword: false,
    createdBy: "usr_1",
    createdAt: FIXED_DATE,
    updatedBy: "usr_1",
    updatedAt: FIXED_DATE,
    deletedBy: null,
    deletedAt: null,
    isDeleted: false,
    ...overrides,
  };
}

// The JSON shape a `fakeUser(...)` serializes to over the wire (dates as ISO
// strings) — what `res.json()` should equal for a 200/201 response.
function fakeUserJson(overrides: Record<string, unknown> = {}) {
  const user = fakeUser(overrides);
  return {
    ...user,
    createdAt: (user.createdAt as Date).toISOString(),
    updatedAt: (user.updatedAt as Date).toISOString(),
    deletedAt: user.deletedAt ? (user.deletedAt as Date).toISOString() : null,
  };
}

function testContainer(e2eEnabled: boolean) {
  const container = createContainer({ injectionMode: "PROXY" });
  container.register({
    // `routes.ts`'s `onRequest` hook always registers `currentUser` (a
    // `CurrentUser` built via `asFunction(({ db }) => ...)`), regardless of
    // which route is hit — so every test container needs a `db` stub even
    // when the use-cases under test are mocked at the `userQueryService` /
    // `updateProfileCommand` level and never call `db` themselves.
    db: asValue({ user: { findByIdOrCognitoSub: vi.fn(async () => null) } } as any),
    env: asValue({ E2E_TESTING_ENABLED: e2eEnabled } as any),
    registerUserCommand: asValue({
      execute: vi.fn(async (input: any) =>
        fakeUser({ id: "usr_1", tags: input.e2eSource ? ["E2E Source"] : [] }),
      ),
    } as any),
    registerPasswordlessCommand: asValue({
      execute: vi.fn(async (input: any) =>
        fakeUser({
          id: "usr_2",
          authType: "PASSWORDLESS",
          tags: input.e2eSource ? ["E2E Source"] : [],
        }),
      ),
    } as any),
    loginUserCommand: asValue({ execute: vi.fn() } as any),
    startOtpChallengeCommand: asValue({ execute: vi.fn(async () => ({ session: "sess_1" })) } as any),
    verifyOtpChallengeCommand: asValue({
      execute: vi.fn(async () => ({ idToken: "id1", accessToken: "acc1", refreshToken: "rt1" })),
    } as any),
    userQueryService: asValue({ getMe: vi.fn(), getUserById: vi.fn() } as any),
    updateProfileCommand: asValue({ execute: vi.fn() } as any),
    // The password-reset trio. `forgotPasswordCommand` resolves to undefined on
    // purpose: the command returns nothing whether or not the email exists, and
    // the route's fixed 202 must not depend on anything it returns.
    forgotPasswordCommand: asValue({ execute: vi.fn(async () => undefined) } as any),
    confirmPasswordResetCommand: asValue({ execute: vi.fn(async () => undefined) } as any),
    changePasswordCommand: asValue({
      execute: vi.fn(async () => fakeUser({ mustChangePassword: false })),
    } as any),
    e2eCleanupCommand: asValue({ execute: vi.fn(async () => ({ count: 3 })) } as any),
  });
  return container;
}

describe("routes", () => {
  it("GET /v1/health returns ok", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("register honors X-E2E-Source only when flag enabled", async () => {
    const app = buildApp(testContainer(true));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register",
      headers: { "x-e2e-source": "true" },
      payload: { email: "a@b.co", password: "P!1", fullName: "A" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().tags).toContain("E2E Source");
  });

  it("register ignores X-E2E-Source when flag disabled", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register",
      headers: { "x-e2e-source": "true" },
      payload: { email: "a@b.co", password: "P!1", fullName: "A" },
    });
    expect(res.json().tags).toEqual([]);
  });

  // `authType` is READ-ONLY: it is never accepted in a request body, only
  // surfaced in the response. PASSWORD is the schema default, so a plain
  // password registration reports it without any route setting it explicitly.
  it("register response includes authType", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register",
      payload: { email: "a@b.co", password: "P!1", fullName: "A" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().authType).toBe("PASSWORD");
  });

  it("register rejects a body missing required fields with 400", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register",
      payload: { email: "a@b.co" }, // missing password + fullName
    });
    expect(res.statusCode).toBe(400);
  });

  // JE-40 item 2: e2e-* routes are protected (not in the public allowlist), so
  // these injects now need an x-user-id header to get past the onRequest 401
  // gate and reach the handler under test.
  it("e2e-cleanup returns 404 when flag disabled", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({
      method: "DELETE", url: "/v1/users/e2e-cleanup",
      headers: { "x-user-id": "usr_actor_1" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("e2e-cleanup soft-deletes when flag enabled", async () => {
    const app = buildApp(testContainer(true));
    const res = await app.inject({
      method: "DELETE", url: "/v1/users/e2e-cleanup",
      headers: { "x-user-id": "usr_actor_1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 3 });
  });

  describe("GET /v1/users/e2e-identity", () => {
    it("returns 404 when E2E_TESTING_ENABLED is false", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "GET", url: "/v1/users/e2e-identity?email=test@example.com",
        headers: { "x-user-id": "usr_actor_1" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns { data: 1, events: 1, cognitoSub } when the query resolves those counts with E2E_TESTING_ENABLED true", async () => {
      const container = testContainer(true);
      container.register({
        e2eIdentityQuery: asValue({
          execute: vi.fn(async () => ({ data: 1, events: 1, cognitoSub: "00000000-0000-0000-0000-000000000000" })),
        } as any),
      });
      const app = buildApp(container);
      const res = await app.inject({
        method: "GET", url: "/v1/users/e2e-identity?email=test@example.com",
        headers: { "x-user-id": "usr_actor_1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: 1, events: 1, cognitoSub: expect.any(String) });
    });

    it("returns { data: 0, events: 0, cognitoSub: null } when no snapshot exists", async () => {
      const container = testContainer(true);
      container.register({
        e2eIdentityQuery: asValue({ execute: vi.fn(async () => ({ data: 0, events: 0, cognitoSub: null })) } as any),
      });
      const app = buildApp(container);
      const res = await app.inject({
        method: "GET", url: "/v1/users/e2e-identity?email=missing@example.com",
        headers: { "x-user-id": "usr_actor_1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: 0, events: 0, cognitoSub: null });
    });

    it("returns 400 when the email query param is missing", async () => {
      const container = testContainer(true);
      container.register({
        e2eIdentityQuery: asValue({ execute: vi.fn() } as any),
      });
      const app = buildApp(container);
      const res = await app.inject({
        method: "GET", url: "/v1/users/e2e-identity",
        headers: { "x-user-id": "usr_actor_1" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "email_required" });
    });
  });

  // JE-40 item 2: the `onRequest` hook in routes.ts reads `x-user-id`, registers
  // it as `currentActor` in `request.diScope` (for handlers, e.g. GET /v1/users/me
  // below), AND runs the rest of the request through `actorContext.run(...)` so
  // the Prisma audit extension can read the same actor from AsyncLocalStorage
  // (see `shared/audit/actor-context.ts`). Both halves are covered here using the
  // documented `buildApp(container)` seam with an isolated Awilix container.
  describe("currentActor from the x-user-id header", () => {
    it("registers currentActor in the DI scope and GET /v1/users/me resolves it via getMe", async () => {
      // `getMe` now receives the request-scoped `CurrentUser` (see
      // `shared/auth/current-user.ts`), not a raw string — assert on its
      // `.identity` and use `.resolve()` to produce the response.
      const getMe = vi.fn(async (currentUser: { identity: string }) =>
        fakeUser({ id: currentUser.identity, email: "a@b.co" }),
      );
      const container = testContainer(false);
      container.register({ userQueryService: asValue({ getMe, getUserById: vi.fn() } as any) });
      const app = buildApp(container);

      const res = await app.inject({
        method: "GET",
        url: "/v1/users/me",
        headers: { "x-user-id": "usr_actor_1" },
      });

      expect(res.statusCode).toBe(200);
      expect(getMe).toHaveBeenCalledWith(expect.objectContaining({ identity: "usr_actor_1" }));
      expect(res.json()).toEqual(fakeUserJson({ id: "usr_actor_1", email: "a@b.co" }));
    });

    it("returns 401 from GET /v1/users/me when x-user-id is absent (auth gate, before the handler runs)", async () => {
      const getMe = vi.fn(async () => ({ id: "should-not-be-called" }));
      const container = testContainer(false);
      container.register({ userQueryService: asValue({ getMe, getUserById: vi.fn() } as any) });
      const app = buildApp(container);

      const res = await app.inject({ method: "GET", url: "/v1/users/me" });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthenticated" });
      expect(getMe).not.toHaveBeenCalled();
    });

    it("propagates x-user-id into actorContext's AsyncLocalStorage for the request's async chain", async () => {
      let observedActor: string | undefined;
      const getMe = vi.fn(async (currentUser: { identity: string }) => {
        // Read the AsyncLocalStorage store from *inside* the same async chain
        // the handler runs in, the same way the Prisma audit extension does
        // when it stamps createdBy/updatedBy (see prisma-extensions.ts).
        observedActor = getActor();
        return fakeUser({ id: currentUser.identity });
      });
      const container = testContainer(false);
      container.register({ userQueryService: asValue({ getMe, getUserById: vi.fn() } as any) });
      const app = buildApp(container);

      const res = await app.inject({
        method: "GET",
        url: "/v1/users/me",
        headers: { "x-user-id": "usr_actor_2" },
      });

      expect(res.statusCode).toBe(200);
      expect(observedActor).toBe("usr_actor_2");
    });

    it("propagates x-user-id into the log context for the request's async chain", async () => {
      let observed: Record<string, unknown> | undefined;
      const getMe = vi.fn(async (currentUser: { identity: string }) => {
        // Read from inside the handler's async chain — the same place the Pino
        // `formatters.log` hook reads it when enriching a log line.
        observed = { ...getLogContext() };
        return fakeUser({ id: currentUser.identity });
      });
      const container = testContainer(false);
      container.register({ userQueryService: asValue({ getMe, getUserById: vi.fn() } as any) });
      const app = buildApp(container);

      const res = await app.inject({
        method: "GET",
        url: "/v1/users/me",
        headers: { "x-user-id": "usr_ctx_1" },
      });

      expect(res.statusCode).toBe(200);
      // `request_id` is seeded on EVERY request (see request-id.test.ts), so
      // the store is matched by its identity fields rather than by equality —
      // an exact match here would break every time a new ambient field is added.
      expect(observed).toMatchObject({ cognito_sub: "usr_ctx_1" });
      expect(observed.request_id).toMatch(/^req_[A-Za-z0-9]{24}$/);
    });

    it("leaves the log context empty on a public route with no x-user-id", async () => {
      let observed: Record<string, unknown> | undefined;
      const container = testContainer(false);
      const app = buildApp(container);
      app.get("/v1/health-probe", async () => {
        observed = { ...getLogContext() };
        return { status: "ok" };
      });

      const res = await app.inject({ method: "GET", url: "/v1/health" });

      expect(res.statusCode).toBe(200);
      // The health route is public, so no identity is known — the context must
      // carry no keys at all rather than a null cognito_sub.
      expect(observed ?? {}).toEqual({});
    });

    it("enriches the context mid-request via setLogContext", async () => {
      let observed: Record<string, unknown> | undefined;
      const getMe = vi.fn(async (currentUser: { identity: string }) => {
        setLogContext({ user_id: "usr_resolved" });
        observed = { ...getLogContext() };
        return fakeUser({ id: currentUser.identity });
      });
      const container = testContainer(false);
      container.register({ userQueryService: asValue({ getMe, getUserById: vi.fn() } as any) });
      const app = buildApp(container);

      const res = await app.inject({
        method: "GET",
        url: "/v1/users/me",
        headers: { "x-user-id": "usr_ctx_2" },
      });

      expect(res.statusCode).toBe(200);
      expect(observed).toMatchObject({ cognito_sub: "usr_ctx_2", user_id: "usr_resolved" });
      expect(observed.request_id).toMatch(/^req_[A-Za-z0-9]{24}$/);
    });

    // The regression this guards: `user_id` used to be set ONLY by the register
    // command, so an authenticated request logged its Cognito sub but never the
    // internal `usr_` id. These two use the REAL UserQueryService over a stubbed
    // db, because a mocked `getMe` would skip `CurrentUser.resolve()` — the very
    // place the enrichment happens.
    it("emits user_id on EVERY log line of an authenticated request, not just register", async () => {
      const lines: string[] = [];
      const row = fakeUser({ id: "usr_from_db", cognitoSub: "sub-abc" });
      const container = testContainer(false);
      container.register({
        db: asValue({ user: { findByIdOrCognitoSub: vi.fn(async () => row) } } as any),
        userQueryService: asFunction(
          (cradle: any) => new UserQueryService(cradle),
          { lifetime: Lifetime.SCOPED },
        ),
      });
      const app = buildApp(container, { logStream: { write: (s: string) => lines.push(s) } });

      const res = await app.inject({
        method: "GET",
        url: "/v1/users/me",
        // The caller is identified by their Cognito sub, so the internal id is
        // NOT derivable from the header — it has to come from the lookup.
        headers: { "x-user-id": "sub-abc" },
      });

      expect(res.statusCode).toBe(200);

      const logged = lines.map((l) => JSON.parse(l));
      // `request completed` is emitted in the onResponse hook, i.e. after the
      // handler resolved the user — the proof that the enrichment reaches lines
      // the resolving code never touches.
      const requestLog = logged.find((entry) => entry.http_route === "/v1/users/me");
      expect(requestLog).toBeDefined();
      expect(requestLog.user_id).toBe("usr_from_db");
      expect(requestLog.cognito_sub).toBe("sub-abc");
      // No line of this request may leak the plaintext email (only login/
      // register log a masked form, and only at their own call sites).
      expect(logged.every((entry) => entry.email === undefined)).toBe(true);

      await app.close();
    });

    it("still serves the request (without user_id) when the sub resolves to no user", async () => {
      const lines: string[] = [];
      const container = testContainer(false);
      container.register({
        // A valid token for a deleted account: the lookup finds nothing.
        db: asValue({ user: { findByIdOrCognitoSub: vi.fn(async () => null) } } as any),
        userQueryService: asFunction(
          (cradle: any) => new UserQueryService(cradle),
          { lifetime: Lifetime.SCOPED },
        ),
      });
      const app = buildApp(container, { logStream: { write: (s: string) => lines.push(s) } });

      const res = await app.inject({
        method: "GET",
        url: "/v1/users/me",
        headers: { "x-user-id": "sub-gone" },
      });

      // The failed resolution must not break the request — it takes the normal
      // 404 path.
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });

      const requestLog = lines
        .map((l) => JSON.parse(l))
        .find((entry) => entry.http_route === "/v1/users/me");
      expect(requestLog).toBeDefined();
      // Absent, never `user_id: null` — null would read as "resolved, and the
      // answer was null" (see log-context.ts).
      expect(requestLog).not.toHaveProperty("user_id");
      expect(requestLog.cognito_sub).toBe("sub-gone");

      await app.close();
    });

    it("does not gate a public route (GET /v1/health) even without x-user-id", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({ method: "GET", url: "/v1/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    });
  });

  it("POST /v1/users/login returns 401 on invalid credentials", async () => {
    const c = testContainer(false);
    c.register({ loginUserCommand: asValue({ execute: vi.fn(async () => { throw new InvalidCredentialsError(); }) } as any) });
    const app = buildApp(c);
    const res = await app.inject({ method: "POST", url: "/v1/users/login", payload: { email: "a@b.co", password: "x" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
  });

  it("POST /v1/users/register returns 409 on duplicate email", async () => {
    const c = testContainer(false);
    c.register({ registerUserCommand: asValue({ execute: vi.fn(async () => { throw new EmailAlreadyExistsError(); }) } as any) });
    const app = buildApp(c);
    const res = await app.inject({
      method: "POST", url: "/v1/users/register",
      payload: { email: "dup@b.co", password: "P@ss", fullName: "D" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "email_exists" });
  });

  it("PATCH /v1/users/me returns 404 when the user is not found", async () => {
    const container = testContainer(false);
    container.register({ updateProfileCommand: asValue({ execute: vi.fn(async () => null) } as any) });
    const app = buildApp(container);
    const res = await app.inject({
      method: "PATCH", url: "/v1/users/me",
      headers: { "x-user-id": "nope" },
      payload: { fullName: "X" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("POST /v1/users/refresh returns 200 with new tokens", async () => {
    const c = testContainer(false);
    c.register({ refreshTokenCommand: asValue({ execute: vi.fn(async () => ({ idToken: "id2", accessToken: "acc2" })) } as any) });
    const app = buildApp(c);
    const res = await app.inject({ method: "POST", url: "/v1/users/refresh", payload: { refreshToken: "rt" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ idToken: "id2", accessToken: "acc2" });
  });

  it("POST /v1/users/refresh returns 401 on invalid refresh token", async () => {
    const c = testContainer(false);
    c.register({ refreshTokenCommand: asValue({ execute: vi.fn(async () => { throw new InvalidCredentialsError(); }) } as any) });
    const app = buildApp(c);
    const res = await app.inject({ method: "POST", url: "/v1/users/refresh", payload: { refreshToken: "bad" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
  });

  // ---- Password reset (self-owned flow, codes in Redis) --------------------
  describe("POST /v1/users/password/forgot", () => {
    it("returns 202 with a fixed body for a known email", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/password/forgot",
        payload: { email: "a@b.co" },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: "accepted" });
    });

    // ==== NO USER ENUMERATION ====
    // The reason this endpoint exists in this shape. If a future change makes
    // an unknown email answer differently — 404, a different body, a different
    // status — this test is the one that must fail.
    it("answers IDENTICALLY for an unknown email (no enumeration)", async () => {
      const known = buildApp(testContainer(false));
      const knownRes = await known.inject({
        method: "POST", url: "/v1/users/password/forgot",
        payload: { email: "a@b.co" },
      });

      const c = testContainer(false);
      // The command resolves without doing anything for an unknown email — the
      // route cannot tell the two apart, which is the point.
      c.register({ forgotPasswordCommand: asValue({ execute: vi.fn(async () => undefined) } as any) });
      const unknown = buildApp(c);
      const unknownRes = await unknown.inject({
        method: "POST", url: "/v1/users/password/forgot",
        payload: { email: "nobody@nowhere.co" },
      });

      expect(unknownRes.statusCode).toBe(knownRes.statusCode);
      expect(unknownRes.json()).toEqual(knownRes.json());
    });

    it("is public — no x-user-id required", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/password/forgot",
        payload: { email: "a@b.co" },
      });
      expect(res.statusCode).not.toBe(401);
    });

    it("rejects a malformed email with 400", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/password/forgot",
        payload: { email: "not-an-email" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /v1/users/password/confirm", () => {
    const valid = { email: "a@b.co", code: "123456", newPassword: "N3wP@ssw0rd!" };

    it("returns 200 when the code is accepted", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/password/confirm", payload: valid,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "password_updated" });
    });

    it("returns 401 invalid_reset_code when the command rejects", async () => {
      const c = testContainer(false);
      c.register({
        confirmPasswordResetCommand: asValue({
          execute: vi.fn(async () => { throw new InvalidResetCodeError(); }),
        } as any),
      });
      const app = buildApp(c);
      const res = await app.inject({
        method: "POST", url: "/v1/users/password/confirm", payload: valid,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_reset_code" });
    });

    it("is public — no x-user-id required", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/password/confirm", payload: valid,
      });
      expect(res.statusCode).not.toBe(401);
    });

    it("rejects a non-6-digit code with 400", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/password/confirm",
        payload: { ...valid, code: "12ab" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PATCH /v1/users/me/password", () => {
    it("returns 200 with the updated user", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "PATCH", url: "/v1/users/me/password",
        headers: { "x-user-id": "usr_1" },
        payload: { newPassword: "N3wP@ssw0rd!" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().mustChangePassword).toBe(false);
    });

    // Unlike the two reset routes, this one is AUTHENTICATED — it is the
    // sibling that must 401 without an identity.
    it("returns 401 without x-user-id", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "PATCH", url: "/v1/users/me/password",
        payload: { newPassword: "N3wP@ssw0rd!" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 when the caller resolves to no user", async () => {
      const c = testContainer(false);
      c.register({ changePasswordCommand: asValue({ execute: vi.fn(async () => null) } as any) });
      const app = buildApp(c);
      const res = await app.inject({
        method: "PATCH", url: "/v1/users/me/password",
        headers: { "x-user-id": "nope" },
        payload: { newPassword: "N3wP@ssw0rd!" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    });

    // The endpoint must NOT double as a profile update: a body carrying
    // `fullName` must not rewrite it. Fastify strips unknown keys, so the proof
    // is that the command receives ONLY `newPassword`.
    it("ignores profile fields — the command receives only newPassword", async () => {
      const execute = vi.fn(async () => fakeUser());
      const c = testContainer(false);
      c.register({ changePasswordCommand: asValue({ execute } as any) });
      const app = buildApp(c);

      await app.inject({
        method: "PATCH", url: "/v1/users/me/password",
        headers: { "x-user-id": "usr_1" },
        payload: { newPassword: "N3wP@ssw0rd!", fullName: "Hacked", tags: ["x"] },
      });

      const [, body] = execute.mock.calls[0]!;
      expect(body).toEqual({ newPassword: "N3wP@ssw0rd!" });
    });

    it("rejects a too-short password with 400", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "PATCH", url: "/v1/users/me/password",
        headers: { "x-user-id": "usr_1" },
        payload: { newPassword: "short" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it("POST /v1/users/refresh returns 400 when refreshToken is missing", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({ method: "POST", url: "/v1/users/refresh", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  describe("POST /v1/users/register/passwordless", () => {
    it("returns 201 with authType PASSWORDLESS", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/register/passwordless",
        payload: { email: "a@b.co", fullName: "A" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().authType).toBe("PASSWORDLESS");
    });

    // Without the tag, global teardown (which deletes by tag) never cleans
    // these users and they leak — the same logic /v1/users/register uses.
    it("honors x-e2e-source only when E2E_TESTING_ENABLED is on", async () => {
      const enabled = buildApp(testContainer(true));
      const tagged = await enabled.inject({
        method: "POST", url: "/v1/users/register/passwordless",
        headers: { "x-e2e-source": "true" },
        payload: { email: "a@b.co", fullName: "A" },
      });
      expect(tagged.json().tags).toContain("E2E Source");

      const disabled = buildApp(testContainer(false));
      const untagged = await disabled.inject({
        method: "POST", url: "/v1/users/register/passwordless",
        headers: { "x-e2e-source": "true" },
        payload: { email: "a@b.co", fullName: "A" },
      });
      expect(untagged.json().tags).toEqual([]);
    });

    it("returns 409 on duplicate email", async () => {
      const c = testContainer(false);
      c.register({
        registerPasswordlessCommand: asValue({
          execute: vi.fn(async () => { throw new EmailAlreadyExistsError(); }),
        } as any),
      });
      const app = buildApp(c);
      const res = await app.inject({
        method: "POST", url: "/v1/users/register/passwordless",
        payload: { email: "dup@b.co", fullName: "D" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "email_exists" });
    });

    it("is reachable without an x-user-id (public route)", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/register/passwordless",
        payload: { email: "a@b.co", fullName: "A" },
      });
      expect(res.statusCode).not.toBe(401);
    });

    it("returns 400 when fullName is missing", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/register/passwordless",
        payload: { email: "a@b.co" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("OTP login endpoints", () => {
    it("POST /v1/users/otp/start returns 200 with a session", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/otp/start",
        payload: { email: "a@b.co" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ session: "sess_1" });
    });

    it("POST /v1/users/otp/start returns 401 invalid_credentials for an unknown user", async () => {
      const c = testContainer(false);
      c.register({
        startOtpChallengeCommand: asValue({
          execute: vi.fn(async () => { throw new InvalidCredentialsError(); }),
        } as any),
      });
      const app = buildApp(c);
      const res = await app.inject({
        method: "POST", url: "/v1/users/otp/start",
        payload: { email: "ghost@b.co" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_credentials" });
    });

    // Same AuthTokens shape as /v1/users/login: the gateway/JWT contract does
    // not change with the authentication path.
    it("POST /v1/users/otp/verify returns 200 with AuthTokens on a correct code", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/otp/verify",
        payload: { email: "a@b.co", session: "sess_1", code: "042817" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ idToken: "id1", accessToken: "acc1", refreshToken: "rt1" });
    });

    it("POST /v1/users/otp/verify returns 401 invalid_otp on an incorrect code", async () => {
      const c = testContainer(false);
      c.register({
        verifyOtpChallengeCommand: asValue({
          execute: vi.fn(async () => { throw new InvalidOtpError(); }),
        } as any),
      });
      const app = buildApp(c);
      const res = await app.inject({
        method: "POST", url: "/v1/users/otp/verify",
        payload: { email: "a@b.co", session: "sess_1", code: "000000" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_otp" });
    });

    it("POST /v1/users/otp/verify returns 400 when code is not 6 digits", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/otp/verify",
        payload: { email: "a@b.co", session: "sess_1", code: "12" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("POST /v1/users/otp/verify returns 400 when code is non-numeric", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({
        method: "POST", url: "/v1/users/otp/verify",
        payload: { email: "a@b.co", session: "sess_1", code: "abcdef" },
      });
      expect(res.statusCode).toBe(400);
    });

    // Both halves are pre-authentication by definition; a missing x-user-id
    // must not 401 them at the onRequest gate.
    it("both OTP routes are public (no x-user-id required)", async () => {
      const app = buildApp(testContainer(false));
      const start = await app.inject({
        method: "POST", url: "/v1/users/otp/start", payload: { email: "a@b.co" },
      });
      const verify = await app.inject({
        method: "POST", url: "/v1/users/otp/verify",
        payload: { email: "a@b.co", session: "sess_1", code: "042817" },
      });
      expect(start.statusCode).toBe(200);
      expect(verify.statusCode).toBe(200);
    });

    // The single most important constraint of this feature: the submitted code
    // must not reach ANY log line of the request, including `request completed`.
    it("never writes the submitted code to any log line of the request", async () => {
      const lines: string[] = [];
      const app = buildApp(testContainer(false), {
        logStream: { write: (s: string) => lines.push(s) },
      });

      const res = await app.inject({
        method: "POST", url: "/v1/users/otp/verify",
        payload: { email: "a@b.co", session: "sess_9", code: "424242" },
      });

      expect(res.statusCode).toBe(200);
      expect(lines.join("\n")).not.toContain("424242");
      expect(lines.join("\n")).not.toContain("sess_9");

      await app.close();
    });
  });
});

function webhookContainer(capture = vi.fn(async () => ({ status: "captured" as const }))) {
  const container = createContainer({ injectionMode: "PROXY" });
  container.register({
    env: asValue({ E2E_TESTING_ENABLED: false, WEBHOOK_SECRET: "s3cret" } as any),
    registerUserCommand: asValue({ execute: vi.fn() } as any),
    registerPasswordlessCommand: asValue({ execute: vi.fn() } as any),
    loginUserCommand: asValue({ execute: vi.fn() } as any),
    startOtpChallengeCommand: asValue({ execute: vi.fn() } as any),
    verifyOtpChallengeCommand: asValue({ execute: vi.fn() } as any),
    userQueryService: asValue({ getMe: vi.fn(), getUserById: vi.fn() } as any),
    updateProfileCommand: asValue({ execute: vi.fn() } as any),
    e2eCleanupCommand: asValue({ execute: vi.fn() } as any),
    captureCognitoIdentityCommand: asValue({ execute: capture } as any),
  });
  return { container, capture };
}

const validEvent = {
  version: "1",
  triggerSource: "PostConfirmation_ConfirmSignUp",
  region: "us-east-1",
  userPoolId: "pool",
  userName: "a@b.com",
  callerContext: { awsSdkVersion: "v3", clientId: "cli_1" },
  request: {
    userAttributes: {
      sub: "7904d681-f590-4b4d-bbce-15348a898873",
      email: "a@b.com",
      email_verified: "true",
    },
  },
};

describe("POST /v1/webhooks/cognito", () => {
  it("401s without the secret, and does not call the command", async () => {
    const { container, capture } = webhookContainer();
    const app = buildApp(container);
    const res = await app.inject({ method: "POST", url: "/v1/webhooks/cognito", payload: validEvent });
    expect(res.statusCode).toBe(401);
    expect(capture).not.toHaveBeenCalled();
  });

  it("401s with a wrong secret", async () => {
    const { container } = webhookContainer();
    const app = buildApp(container);
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks/cognito",
      headers: { "x-webhook-secret": "wrong" }, payload: validEvent,
    });
    expect(res.statusCode).toBe(401);
  });

  it("422s on an unsupported trigger", async () => {
    const { container, capture } = webhookContainer();
    const app = buildApp(container);
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks/cognito",
      headers: { "x-webhook-secret": "s3cret" },
      payload: { ...validEvent, triggerSource: "PostAuthentication_Authentication" },
    });
    expect(res.statusCode).toBe(422);
    expect(capture).not.toHaveBeenCalled();
  });

  it("200s on capture", async () => {
    const { container } = webhookContainer();
    const app = buildApp(container);
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks/cognito",
      headers: { "x-webhook-secret": "s3cret" }, payload: validEvent,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "captured" });
  });

  it("200s on a duplicate — idempotent, not an error", async () => {
    const { container } = webhookContainer(vi.fn(async () => ({ status: "duplicate" as const })));
    const app = buildApp(container);
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks/cognito",
      headers: { "x-webhook-secret": "s3cret" }, payload: validEvent,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "duplicate" });
  });

  it("500s when the command reports no matching users row (NoMatchingUserError)", async () => {
    const { container } = webhookContainer(
      vi.fn(async () => {
        throw new NoMatchingUserError("a@b.com");
      }),
    );
    const lines: string[] = [];
    const app = buildApp(container, { logStream: { write: (s: string) => lines.push(s) } });
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks/cognito",
      headers: { "x-webhook-secret": "s3cret" }, payload: validEvent,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "no_matching_user" });

    // The `cognito_webhook_no_match` line is NOT emitted here any more: this
    // point sits outside the `cognito_webhook` span, which has already ended by
    // the time the error surfaces, so a line logged here carried a different
    // span_id and was invisible from the span in OpenObserve. The command owns
    // it now — capture-cognito-identity.test.ts asserts both its fields and
    // that it lands inside the span. Asserting its ABSENCE here is what keeps
    // the failure from being double-logged if it is ever re-added.
    const routeLine = lines
      .map((l) => JSON.parse(l))
      .find((entry) => entry.app_event === "cognito_webhook_no_match");
    expect(routeLine).toBeUndefined();

    await app.close();
  });
});

// The `onResponse` hook publishes `http_errors_total` for any status >= 400, and
// nothing at all for 2xx/3xx. A metric per successful response would be a
// request-rate metric, which the request log already provides.
describe("http_errors_total", () => {
  function containerWithMetrics(publish: ReturnType<typeof vi.fn>) {
    const container = testContainer(false);
    container.register({ metricsPublisher: asValue({ publish } as any) });
    return container;
  }

  it("publishes http_errors_total with StatusClass 4xx on a 401", async () => {
    const publish = vi.fn(async () => undefined);
    const built = buildApp(containerWithMetrics(publish));
    // No x-user-id: the onRequest hook short-circuits with 401 before any handler.
    const res = await built.inject({ method: "GET", url: "/v1/users/me" });
    expect(res.statusCode).toBe(401);
    expect(publish).toHaveBeenCalledWith("http_errors_total", 1, {
      Service: "users",
      StatusClass: "4xx",
    });
    await built.close();
  });

  it("publishes http_errors_total with StatusClass 5xx on a 500", async () => {
    const publish = vi.fn(async () => undefined);
    const container = containerWithMetrics(publish);
    container.register({
      userQueryService: asValue({
        getMe: vi.fn(async () => {
          throw new Error("boom");
        }),
        getUserById: vi.fn(),
      } as any),
    });
    const built = buildApp(container);
    const res = await built.inject({
      method: "GET", url: "/v1/users/me",
      headers: { "x-user-id": "usr_actor_1" },
    });
    expect(res.statusCode).toBe(500);
    expect(publish).toHaveBeenCalledWith("http_errors_total", 1, {
      Service: "users",
      StatusClass: "5xx",
    });
    await built.close();
  });

  it("publishes nothing on a 2xx", async () => {
    const publish = vi.fn(async () => undefined);
    const built = buildApp(containerWithMetrics(publish));
    const res = await built.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(publish).not.toHaveBeenCalled();
    await built.close();
  });
});

describe("openapi spec generation", () => {
  it("app.swagger() exposes all routes and the User component", async () => {
    const { buildApp } = await import("#features/users/http/routes");
    const { createContainer, asValue } = await import("awilix");
    const c = createContainer({ injectionMode: "PROXY" });
    c.register({ env: asValue({ E2E_TESTING_ENABLED: true } as any) });
    const app = buildApp(c as any);
    await app.ready();
    const spec = app.swagger() as any;
    const paths = Object.keys(spec.paths);
    expect(paths).toEqual(expect.arrayContaining([
      "/v1/health", "/v1/users/register", "/v1/users/register/passwordless",
      "/v1/users/login", "/v1/users/otp/start", "/v1/users/otp/verify",
      "/v1/users/me", "/v1/webhooks/cognito",
      "/v1/users/password/forgot", "/v1/users/password/confirm", "/v1/users/me/password",
      "/v1/users/e2e-cleanup", "/v1/users/e2e-identity",
    ]));
    expect(spec.components.schemas.User).toBeDefined();
    // Request bodies are named components (GOLDEN RULE §2a), not inline
    // anonymous schemas — the provider suffixes request variants with "Input".
    expect(spec.components.schemas.OtpStartInput).toBeDefined();
    expect(spec.components.schemas.OtpVerifyInput).toBeDefined();
    expect(spec.components.schemas.RegisterPasswordlessInput).toBeDefined();
    await app.close();
  });
});
