import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const query = vi.fn(async () => []);
const store = { query } as unknown as import("#e2e/email-store").E2eEmailStore;

function eventWith(overrides: Record<string, unknown> = {}) {
  return {
    requestContext: { http: { method: "GET" } },
    headers: { "x-e2e-token": "secret-token" },
    queryStringParameters: { runId: "run_abc" },
    ...overrides,
  };
}

// The module reads env at import time, so each case re-imports with a fresh
// environment rather than mutating a cached module.
async function load(envOverrides: Record<string, string>) {
  vi.resetModules();
  // The required vars must be restubbed on EVERY load: resetModules makes
  // #shared/config/env re-parse process.env (ADR-0014), and without these the
  // suite fails with a ZodError about DOCDB_HOST rather than anything to do
  // with access control.
  vi.stubEnv("DOCDB_HOST", "docdb-test");
  vi.stubEnv("DOCDB_USERNAME", "docdb-test");
  vi.stubEnv("DOCDB_PASSWORD", "docdb-test");
  vi.stubEnv("SES_FROM_ADDRESS", "no-reply@3mrai.local");
  vi.stubEnv("ASSETS_BASE_URL", "http://localhost:4566/assets");
  // Cleared to UNDEFINED first, so a case that omits one is not silently
  // inheriting the previous case's value — which would make the "no token
  // configured" test pass for the wrong reason.
  //
  // undefined, not "": the schema declares E2E_QUERY_TOKEN as .min(1).optional(),
  // so an empty string is a VALIDATION ERROR rather than an absent value, and
  // stubbing "" would fail env parsing instead of exercising the unset path.
  vi.stubEnv("E2E_TESTING_ENABLED", undefined);
  vi.stubEnv("E2E_QUERY_TOKEN", undefined);
  for (const [k, v] of Object.entries(envOverrides)) vi.stubEnv(k, v);
  return await import("#e2e/http-query");
}

const ENABLED = { E2E_TESTING_ENABLED: "true", E2E_QUERY_TOKEN: "secret-token" };

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("handleEmailQuery — access control", () => {
  it("serves the query when enabled and correctly authenticated", async () => {
    const { handleEmailQuery } = await load(ENABLED);
    const res = await handleEmailQuery(eventWith(), store);
    expect(res.statusCode).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_abc" }));
  });

  it("404s when the flag is off, without touching the store", async () => {
    const { handleEmailQuery } = await load({ ...ENABLED, E2E_TESTING_ENABLED: "false" });
    const res = await handleEmailQuery(eventWith(), store);
    expect(res.statusCode).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it("404s when no token is configured, rather than serving unauthenticated", async () => {
    // The closed failure mode: a missing secret must disable the route, never
    // open it.
    const { handleEmailQuery } = await load({ E2E_TESTING_ENABLED: "true" });
    const res = await handleEmailQuery(eventWith(), store);
    expect(res.statusCode).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it("404s on a wrong token", async () => {
    const { handleEmailQuery } = await load(ENABLED);
    const res = await handleEmailQuery(
      eventWith({ headers: { "x-e2e-token": "wrong" } }),
      store,
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns the same status and body for a wrong token as for a disabled route", async () => {
    // Indistinguishable on purpose: a different response would confirm the
    // route exists on a function holding live credentials.
    const disabled = await load({ ...ENABLED, E2E_TESTING_ENABLED: "false" });
    const disabledRes = await disabled.handleEmailQuery(eventWith(), store);
    const enabled = await load(ENABLED);
    const wrongTokenRes = await enabled.handleEmailQuery(
      eventWith({ headers: { "x-e2e-token": "wrong" } }),
      store,
    );
    expect(wrongTokenRes.statusCode).toBe(disabledRes.statusCode);
    expect(wrongTokenRes.body).toBe(disabledRes.body);
  });
});

describe("handleEmailQuery — request handling", () => {
  it("400s when runId is missing, because an unscoped query is never correct", async () => {
    const { handleEmailQuery } = await load(ENABLED);
    const res = await handleEmailQuery(eventWith({ queryStringParameters: {} }), store);
    expect(res.statusCode).toBe(400);
  });

  it("passes the optional filters through", async () => {
    const { handleEmailQuery } = await load(ENABLED);
    await handleEmailQuery(
      eventWith({
        queryStringParameters: { runId: "run_abc", to: "a@b.com", templateKey: "auth-otp", limit: "5" },
      }),
      store,
    );
    expect(query).toHaveBeenCalledWith({
      runId: "run_abc",
      to: "a@b.com",
      templateKey: "auth-otp",
      limit: 5,
    });
  });

  it("405s on a non-GET method", async () => {
    const { handleEmailQuery } = await load(ENABLED);
    const res = await handleEmailQuery(
      eventWith({ requestContext: { http: { method: "DELETE" } } }),
      store,
    );
    expect(res.statusCode).toBe(405);
  });

  it("returns JSON with a count and the emails", async () => {
    const { handleEmailQuery } = await load(ENABLED);
    query.mockResolvedValueOnce([{ to: "a@b.com", code: "123456" }] as never);
    const res = await handleEmailQuery(eventWith(), store);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ count: 1, emails: [{ to: "a@b.com", code: "123456" }] });
  });
});

describe("isFunctionUrlEvent", () => {
  it("recognises a Function URL event", async () => {
    const { isFunctionUrlEvent } = await load(ENABLED);
    expect(isFunctionUrlEvent(eventWith())).toBe(true);
  });

  it("does not mistake an SQS batch for one", async () => {
    // The discriminator the handler relies on. A false positive here would
    // route real messages into the query path and drop them.
    const { isFunctionUrlEvent } = await load(ENABLED);
    expect(isFunctionUrlEvent({ Records: [{ messageId: "m", body: "{}" }] })).toBe(false);
  });

  it("does not mistake the metrics tick for one", async () => {
    const { isFunctionUrlEvent } = await load(ENABLED);
    expect(isFunctionUrlEvent({ "detail-type": "3mrai.metrics.tick" })).toBe(false);
  });
});
