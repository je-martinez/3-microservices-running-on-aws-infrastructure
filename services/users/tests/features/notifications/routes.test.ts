import { describe, it, expect, beforeEach, vi } from "vitest";
import { createContainer, asValue } from "awilix";
import { buildApp } from "#features/users/http/routes";

const ACTOR = "sub-abc";

function page(overrides?: Record<string, unknown>) {
  return {
    items: [
      {
        id: "ntf_1",
        userId: "usr_alice",
        type: "ORDER_STATUS",
        title: "Your order has shipped",
        body: "ORD-3MRAI-10482 · Handed to the carrier and on its way to you.",
        metadata: { status: "SHIPPED", order_id: "ord_1", occurred_at: "2026-08-01T17:48:03" },
        readAt: null,
        createdAt: new Date("2026-08-01T17:48:03Z"),
      },
    ],
    unread_count: 3,
    window_total: 7,
    window_days: 90,
    ...overrides,
  };
}

// An isolated container, so buildApp registers nothing real — the pattern the
// existing route tests use. `db` is needed even when nothing touches it: the
// onRequest hook always builds a CurrentUser from it.
function container(stubs: Record<string, unknown>) {
  const c = createContainer({ injectionMode: "PROXY" });
  c.register({
    db: asValue({ user: { findByIdOrCognitoSub: vi.fn(async () => null) } } as never),
    env: asValue({ E2E_TESTING_ENABLED: false } as never),
    metricsPublisher: asValue({ publish: () => undefined } as never),
    ...Object.fromEntries(Object.entries(stubs).map(([key, value]) => [key, asValue(value)])),
  } as never);
  return c as never;
}

describe("GET /v1/notifications", () => {
  let calls: Array<string>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    calls = [];
    app = buildApp(
      container({
        notificationQueryService: {
          list: async (_user: unknown, filter: string) => {
            calls.push(filter);
            return page();
          },
          unreadCount: async () => 3,
        },
        markNotificationsReadCommand: { execute: async () => ({ updated: 0, unread_count: 3 }) },
      }),
    );
  });

  it("returns the page for an authenticated caller", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: { "x-user-id": ACTOR },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ unread_count: 3, window_total: 7, window_days: 90 });
    expect(body.items[0]).toMatchObject({
      id: "ntf_1",
      type: "ORDER_STATUS",
      title: "Your order has shipped",
      read_at: null,
    });
    // The wire shape is snake_case and carries an ISO string, not a Date.
    expect(typeof body.items[0].created_at).toBe("string");
    // `metadata` passes through whole: the web derives icon, tint and CTA from it.
    expect(body.items[0].metadata).toEqual({
      status: "SHIPPED",
      order_id: "ord_1",
      occurred_at: "2026-08-01T17:48:03",
    });
    // The internal `userId` is not on the wire — the caller is the only possible owner.
    expect(body.items[0].userId).toBeUndefined();
  });

  it("defaults the filter to all", async () => {
    await app.inject({ method: "GET", url: "/v1/notifications", headers: { "x-user-id": ACTOR } });
    expect(calls).toEqual(["all"]);
  });

  it.each(["all", "unread", "read"])("accepts filter=%s", async (filter) => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/notifications?filter=${filter}`,
      headers: { "x-user-id": ACTOR },
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toContain(filter);
  });

  it("rejects an unknown filter with 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/notifications?filter=archived",
      headers: { "x-user-id": ACTOR },
    });
    expect(response.statusCode).toBe(400);
  });

  // CONTRACT: absent from public-routes.ts, which is what makes this 401.
  it("401s without an identity", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/notifications" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthenticated" });
  });

  // A read notification serializes read_at as an ISO string, not a Date: Zod's
  // serializer rejects a Date against z.string() rather than coercing it.
  it("serializes a read notification's read_at as an ISO string", async () => {
    const readApp = buildApp(
      container({
        notificationQueryService: {
          list: async () =>
            page({
              items: [
                {
                  id: "ntf_2",
                  userId: "usr_alice",
                  type: "WELCOME",
                  title: "Welcome to 3MRAI",
                  body: "Your account is ready.",
                  metadata: { occurred_at: "2026-08-01T17:48:03" },
                  readAt: new Date("2026-08-02T10:00:00Z"),
                  createdAt: new Date("2026-08-01T17:48:03Z"),
                },
              ],
            }),
          unreadCount: async () => 0,
        },
        markNotificationsReadCommand: { execute: async () => ({ updated: 0, unread_count: 0 }) },
      }),
    );

    const response = await readApp.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: { "x-user-id": ACTOR },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0].read_at).toBe("2026-08-02T10:00:00.000Z");
  });
});

describe("GET /v1/notifications/unread-count", () => {
  it("returns just the count", async () => {
    const app = buildApp(
      container({
        notificationQueryService: { list: async () => page(), unreadCount: async () => 12 },
        markNotificationsReadCommand: { execute: async () => ({ updated: 0, unread_count: 12 }) },
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/v1/notifications/unread-count",
      headers: { "x-user-id": ACTOR },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ unread_count: 12 });
  });

  it("401s without an identity", async () => {
    const app = buildApp(
      container({
        notificationQueryService: { list: async () => page(), unreadCount: async () => 0 },
        markNotificationsReadCommand: { execute: async () => ({ updated: 0, unread_count: 0 }) },
      }),
    );
    const response = await app.inject({ method: "GET", url: "/v1/notifications/unread-count" });
    expect(response.statusCode).toBe(401);
  });
});

describe("PATCH /v1/notifications/read", () => {
  function appWith(updated: number, unread = 1) {
    const seen: string[][] = [];
    const app = buildApp(
      container({
        notificationQueryService: { list: async () => page(), unreadCount: async () => unread },
        markNotificationsReadCommand: {
          execute: async (_user: unknown, ids: string[]) => {
            seen.push(ids);
            return { updated, unread_count: unread };
          },
        },
      }),
    );
    return { app, seen };
  }

  it("marks a list of ids read", async () => {
    const { app, seen } = appWith(2);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      headers: { "x-user-id": ACTOR },
      payload: { ids: ["ntf_1", "ntf_2"] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ updated: 2, unread_count: 1 });
    expect(seen[0]).toEqual(["ntf_1", "ntf_2"]);
  });

  // CONTRACT: 200 with updated: 0, NOT 400 — arriving with nothing unread is the
  // normal case for mark-on-enter.
  it("answers 200 for an empty id list", async () => {
    const { app } = appWith(0);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      headers: { "x-user-id": ACTOR },
      payload: { ids: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ updated: 0 });
  });

  // CONTRACT: A single-id PATCH affecting 0 rows returns 404, indistinguishable
  // from "does not exist" — deliberately, so it leaks nothing about another
  // user's notifications.
  it("404s when a single id matched nothing", async () => {
    const { app } = appWith(0);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      headers: { "x-user-id": ACTOR },
      payload: { ids: ["ntf_someone_elses"] },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  // A single id that DID match is the ordinary success path; only a zero 404s.
  it("200s when a single id matched", async () => {
    const { app } = appWith(1);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      headers: { "x-user-id": ACTOR },
      payload: { ids: ["ntf_1"] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ updated: 1, unread_count: 1 });
  });

  it("does NOT 404 when a multi-id PATCH matched nothing", async () => {
    // Several ids are a bulk operation; some already being read is routine.
    const { app } = appWith(0);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      headers: { "x-user-id": ACTOR },
      payload: { ids: ["ntf_1", "ntf_2"] },
    });

    expect(response.statusCode).toBe(200);
  });

  it("accepts exactly 50 ids", async () => {
    const { app } = appWith(50);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      headers: { "x-user-id": ACTOR },
      payload: { ids: Array.from({ length: 50 }, (_, i) => `ntf_${i}`) },
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects more than 50 ids with 400", async () => {
    const { app } = appWith(0);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      headers: { "x-user-id": ACTOR },
      payload: { ids: Array.from({ length: 51 }, (_, i) => `ntf_${i}`) },
    });

    expect(response.statusCode).toBe(400);
  });

  it("401s without an identity", async () => {
    const { app } = appWith(0);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      payload: { ids: ["ntf_1"] },
    });
    expect(response.statusCode).toBe(401);
  });
});
