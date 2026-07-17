import { describe, it, expect, vi } from "vitest";
import { createContainer, asValue } from "awilix";
import { buildApp } from "#features/users/http/routes";
import { getActor } from "#shared/audit/actor-context";
import { NoMatchingUserError } from "#features/users/webhooks/capture-cognito-identity";
import { InvalidCredentialsError, EmailAlreadyExistsError } from "#shared/auth/auth-errors";

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
    env: asValue({ E2E_TESTING_ENABLED: e2eEnabled } as any),
    registerUserCommand: asValue({
      execute: vi.fn(async (input: any) =>
        fakeUser({ id: "usr_1", tags: input.e2eSource ? ["E2E Source"] : [] }),
      ),
    } as any),
    loginUserCommand: asValue({ execute: vi.fn() } as any),
    userQueryService: asValue({ getMe: vi.fn(), getUserById: vi.fn() } as any),
    updateProfileCommand: asValue({ execute: vi.fn() } as any),
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

  it("register rejects a body missing required fields with 400", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register",
      payload: { email: "a@b.co" }, // missing password + fullName
    });
    expect(res.statusCode).toBe(400);
  });

  it("e2e-cleanup returns 404 when flag disabled", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({ method: "DELETE", url: "/v1/users/e2e-cleanup" });
    expect(res.statusCode).toBe(404);
  });

  it("e2e-cleanup soft-deletes when flag enabled", async () => {
    const app = buildApp(testContainer(true));
    const res = await app.inject({ method: "DELETE", url: "/v1/users/e2e-cleanup" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 3 });
  });

  describe("GET /v1/users/e2e-identity", () => {
    it("returns 404 when E2E_TESTING_ENABLED is false", async () => {
      const app = buildApp(testContainer(false));
      const res = await app.inject({ method: "GET", url: "/v1/users/e2e-identity?email=test@example.com" });
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
      const res = await app.inject({ method: "GET", url: "/v1/users/e2e-identity?email=test@example.com" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: 1, events: 1, cognitoSub: expect.any(String) });
    });

    it("returns { data: 0, events: 0, cognitoSub: null } when no snapshot exists", async () => {
      const container = testContainer(true);
      container.register({
        e2eIdentityQuery: asValue({ execute: vi.fn(async () => ({ data: 0, events: 0, cognitoSub: null })) } as any),
      });
      const app = buildApp(container);
      const res = await app.inject({ method: "GET", url: "/v1/users/e2e-identity?email=missing@example.com" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: 0, events: 0, cognitoSub: null });
    });

    it("returns 400 when the email query param is missing", async () => {
      const container = testContainer(true);
      container.register({
        e2eIdentityQuery: asValue({ execute: vi.fn() } as any),
      });
      const app = buildApp(container);
      const res = await app.inject({ method: "GET", url: "/v1/users/e2e-identity" });
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
      const getMe = vi.fn(async (userId: string) => fakeUser({ id: userId, email: "a@b.co" }));
      const container = testContainer(false);
      container.register({ userQueryService: asValue({ getMe, getUserById: vi.fn() } as any) });
      const app = buildApp(container);

      const res = await app.inject({
        method: "GET",
        url: "/v1/users/me",
        headers: { "x-user-id": "usr_actor_1" },
      });

      expect(res.statusCode).toBe(200);
      expect(getMe).toHaveBeenCalledWith("usr_actor_1");
      expect(res.json()).toEqual(fakeUserJson({ id: "usr_actor_1", email: "a@b.co" }));
    });

    it("returns 404 from GET /v1/users/me when x-user-id is absent (currentActor is undefined)", async () => {
      const getMe = vi.fn(async () => ({ id: "should-not-be-called" }));
      const container = testContainer(false);
      container.register({ userQueryService: asValue({ getMe, getUserById: vi.fn() } as any) });
      const app = buildApp(container);

      const res = await app.inject({ method: "GET", url: "/v1/users/me" });

      expect(res.statusCode).toBe(404);
      expect(getMe).not.toHaveBeenCalled();
    });

    it("propagates x-user-id into actorContext's AsyncLocalStorage for the request's async chain", async () => {
      let observedActor: string | undefined;
      const getMe = vi.fn(async (userId: string) => {
        // Read the AsyncLocalStorage store from *inside* the same async chain
        // the handler runs in, the same way the Prisma audit extension does
        // when it stamps createdBy/updatedBy (see prisma-extensions.ts).
        observedActor = getActor();
        return fakeUser({ id: userId });
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

  it("POST /v1/users/refresh returns 400 when refreshToken is missing", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({ method: "POST", url: "/v1/users/refresh", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

function webhookContainer(capture = vi.fn(async () => ({ status: "captured" as const }))) {
  const container = createContainer({ injectionMode: "PROXY" });
  container.register({
    env: asValue({ E2E_TESTING_ENABLED: false, WEBHOOK_SECRET: "s3cret" } as any),
    registerUserCommand: asValue({ execute: vi.fn() } as any),
    loginUserCommand: asValue({ execute: vi.fn() } as any),
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

    // The business-event log this route emits on the failure path: a clear
    // message plus an `app_*`-prefixed event field, no un-prefixed business
    // fields (see docs/shared/conventions for the schema shape) — and the
    // error object is preserved so error_type/error_message serialize.
    const businessLog = lines
      .map((l) => JSON.parse(l))
      .find((entry) => entry.app_event === "cognito_webhook_no_match");
    expect(businessLog).toBeDefined();
    expect(businessLog.message).toBe(
      "cognito webhook: no matching users row for confirmed identity",
    );
    expect(businessLog.err).toBeDefined();
    expect(businessLog.no_matching_user).toBeUndefined();
    expect(businessLog.userName).toBeUndefined();

    await app.close();
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
      "/v1/health", "/v1/users/register", "/v1/users/login",
      "/v1/users/me", "/v1/webhooks/cognito",
      "/v1/users/e2e-cleanup", "/v1/users/e2e-identity",
    ]));
    expect(spec.components.schemas.User).toBeDefined();
    await app.close();
  });
});
