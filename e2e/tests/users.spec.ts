import { test, expect } from "@playwright/test";
import { apiClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";

test("health is ok", async () => {
  const api = await apiClient();
  const res = await api.get("/v1/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("register marks the user as E2E Source", async () => {
  const api = await apiClient();
  const res = await api.post("/v1/users/register", { data: makeUser() });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.tags).toContain("E2E Source");
});

test("login returns Cognito tokens", async () => {
  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });
  const res = await api.post("/v1/users/login", { data: { email: user.email, password: user.password } });
  expect(res.status()).toBe(200);
  expect((await res.json()).idToken).toBeTruthy();
});

test("GET /v1/users/me returns the caller's profile when x-user-id is present", async () => {
  const api = await apiClient();
  const user = makeUser();
  const registered = await api.post("/v1/users/register", { data: user });
  const { id } = await registered.json();

  // In production the API Gateway JWT authorizer validates the Cognito token
  // and injects `x-user-id` for the service to trust. The service itself does
  // not validate JWTs — it only reads this header (see routes.ts onRequest
  // hook) — so E2E specs simulate the authorizer's output directly.
  const me = await api.get("/v1/users/me", { headers: { "x-user-id": id } });
  expect(me.status()).toBe(200);
  const body = await me.json();
  expect(body.email).toBe(user.email);
  expect(body.fullName).toBe(user.fullName);
});

test("PATCH /v1/users/me updates the profile and the change is visible on a subsequent GET", async () => {
  const api = await apiClient();
  const user = makeUser();
  const registered = await api.post("/v1/users/register", { data: user });
  const { id } = await registered.json();

  const newFullName = `${user.fullName} Updated`;
  const patch = await api.patch("/v1/users/me", {
    headers: { "x-user-id": id },
    data: { fullName: newFullName },
  });
  expect(patch.status()).toBe(200);
  expect((await patch.json()).fullName).toBe(newFullName);

  const me = await api.get("/v1/users/me", { headers: { "x-user-id": id } });
  expect(me.status()).toBe(200);
  expect((await me.json()).fullName).toBe(newFullName);
});

// The caller-context refactor moved auth enforcement to the `onRequest` hook
// (routes.ts): a missing `x-user-id` on a non-public route now short-circuits
// with 401 `{ error: "unauthenticated" }` before any handler runs (see
// shared/http/public-routes.ts — `/v1/users/me` is not in the public
// allowlist). This replaces the old pre-refactor behavior, where the request
// reached the `getMe` handler and fell through to a 404 because `currentActor`
// was undefined. This test now legitimately covers that middleware auth gate.
test("GET /v1/users/me without x-user-id returns 401 (middleware auth gate)", async () => {
  const api = await apiClient();
  const res = await api.get("/v1/users/me");
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthenticated" });
});

test("register captures Cognito identity into both tables", async () => {
  const api = await apiClient();
  const user = makeUser();
  const res = await api.post("/v1/users/register", { data: user });
  expect(res.status()).toBe(201);
  const { id } = await res.json();

  // The identity snapshot is written in-process by register() (spec D2), so it
  // is visible immediately — no polling. The e2e-identity endpoint exists only
  // when E2E_TESTING_ENABLED (see Task 8), mirroring e2e-cleanup. It is now a
  // protected route (the caller-context refactor made it subject to the same
  // auth gate as every other non-public route), so send `x-user-id` like the
  // passing `/v1/users/me` test above.
  const identity = await api.get(`/v1/users/e2e-identity?email=${encodeURIComponent(user.email)}`, {
    headers: { "x-user-id": id },
  });
  expect(identity.status()).toBe(200);
  expect(await identity.json()).toMatchObject({ data: 1, events: 1 });
});

test("replaying the same Cognito event does not add a second event row (D4)", async () => {
  const api = await apiClient();
  const user = makeUser();
  const registered = await api.post("/v1/users/register", { data: user });
  const { id } = await registered.json();

  // The sub is the idempotency input; fetch it via the E2E-only endpoint
  // (protected — send x-user-id, same as the identity-capture test above).
  const identity = await (
    await api.get(`/v1/users/e2e-identity?email=${encodeURIComponent(user.email)}`, {
      headers: { "x-user-id": id },
    })
  ).json();
  expect(identity).toMatchObject({ data: 1, events: 1 });
  const sub: string = identity.cognitoSub;

  // Replay the exact PostConfirmation event through the real webhook route.
  // Same sub + triggerSource → same derived message_id → ON CONFLICT DO NOTHING.
  const replay = await api.post("/v1/webhooks/cognito", {
    headers: { "x-webhook-secret": process.env.WEBHOOK_SECRET ?? "local-dev-secret" },
    data: {
      version: "1",
      triggerSource: "PostConfirmation_ConfirmSignUp",
      region: "us-east-1",
      userPoolId: "local",
      userName: user.email,
      callerContext: { awsSdkVersion: "local", clientId: "local" },
      request: { userAttributes: { sub, email: user.email, email_verified: "true" } },
    },
  });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toEqual({ status: "duplicate" });

  // The event count must still be 1 — the replay was swallowed (spec D4).
  const after = await (
    await api.get(`/v1/users/e2e-identity?email=${encodeURIComponent(user.email)}`, {
      headers: { "x-user-id": id },
    })
  ).json();
  expect(after.events).toBe(1);
});
