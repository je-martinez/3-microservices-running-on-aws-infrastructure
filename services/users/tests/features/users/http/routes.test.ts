import { describe, it, expect, vi } from "vitest";
import { createContainer, asValue } from "awilix";
import { buildApp } from "#features/users/http/routes";
import { getActor } from "#shared/audit/actor-context";
import { NoMatchingUserError } from "#features/users/webhooks/capture-cognito-identity";

function testContainer(e2eEnabled: boolean) {
  const container = createContainer({ injectionMode: "PROXY" });
  container.register({
    env: asValue({ E2E_TESTING_ENABLED: e2eEnabled } as any),
    registerUserCommand: asValue({
      execute: vi.fn(async (input: any) => ({ id: "usr_1", tags: input.e2eSource ? ["E2E Source"] : [] })),
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
      payload: { email: "a@b.c", password: "P!1", fullName: "A" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().tags).toContain("E2E Source");
  });

  it("register ignores X-E2E-Source when flag disabled", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register",
      headers: { "x-e2e-source": "true" },
      payload: { email: "a@b.c", password: "P!1", fullName: "A" },
    });
    expect(res.json().tags).toEqual([]);
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

  // JE-40 item 2: the `onRequest` hook in routes.ts reads `x-user-id`, registers
  // it as `currentActor` in `request.diScope` (for handlers, e.g. GET /v1/users/me
  // below), AND runs the rest of the request through `actorContext.run(...)` so
  // the Prisma audit extension can read the same actor from AsyncLocalStorage
  // (see `shared/audit/actor-context.ts`). Both halves are covered here using the
  // documented `buildApp(container)` seam with an isolated Awilix container.
  describe("currentActor from the x-user-id header", () => {
    it("registers currentActor in the DI scope and GET /v1/users/me resolves it via getMe", async () => {
      const getMe = vi.fn(async (userId: string) => ({ id: userId, email: "a@b.c" }));
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
      expect(res.json()).toEqual({ id: "usr_actor_1", email: "a@b.c" });
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
        return { id: userId };
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
    const app = buildApp(container);
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks/cognito",
      headers: { "x-webhook-secret": "s3cret" }, payload: validEvent,
    });
    expect(res.statusCode).toBe(500);
  });
});
