import { describe, it, expect } from "vitest";
import {
  NOTIFICATIONS_LIMIT,
  WINDOW_DAYS,
  NotificationQueryService,
} from "#features/notifications/queries/list-notifications";

function row(id: string, readAt: Date | null) {
  return {
    id,
    userId: "usr_alice",
    type: "ORDER_STATUS",
    title: "Your order has shipped",
    body: "ORD-3MRAI-10482 · Handed to the carrier and on its way to you.",
    metadata: { status: "SHIPPED", occurred_at: "2026-08-01T17:48:03" },
    readAt,
    createdAt: new Date("2026-08-01T17:48:03Z"),
  };
}

function fakeDb(rows = [row("ntf_1", null)], counts = { unread: 1, window: 1 }) {
  const findManyArgs: Array<Record<string, unknown>> = [];
  const countArgs: Array<Record<string, unknown>> = [];
  return {
    findManyArgs,
    countArgs,
    db: {
      notification: {
        findMany: async (args: Record<string, unknown>) => {
          findManyArgs.push(args);
          return rows;
        },
        count: async (args: Record<string, unknown>) => {
          countArgs.push(args);
          // The unread count is the one filtered on readAt: null.
          const where = args.where as Record<string, unknown>;
          return where.readAt === null ? counts.unread : counts.window;
        },
      },
    } as never,
  };
}

const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) } as never;

describe("NotificationQueryService.list", () => {
  it("returns the newest 50 by createdAt desc, scoped to the caller", async () => {
    const { db, findManyArgs } = fakeDb();
    const page = await new NotificationQueryService({ db }).list(currentUser, "all");

    expect(findManyArgs[0]).toMatchObject({
      where: { userId: "usr_alice" },
      orderBy: { createdAt: "desc" },
      take: NOTIFICATIONS_LIMIT,
    });
    expect(page.items).toHaveLength(1);
    expect(page.window_days).toBe(WINDOW_DAYS);
  });

  it("caps the list at 50", () => {
    expect(NOTIFICATIONS_LIMIT).toBe(50);
  });

  // CONTRACT: The list query carries NO date bound — only window_total is scoped
  // to 90 days. A date-filtered list would hide the WELCOME row the All screen
  // shows in its EARLIER group.
  it("applies no date bound to the list itself", async () => {
    const { db, findManyArgs } = fakeDb();
    await new NotificationQueryService({ db }).list(currentUser, "all");

    expect(JSON.stringify(findManyArgs[0]!.where)).not.toContain("createdAt");
  });

  it.each([
    ["unread", null],
    ["read", { not: null }],
  ] as const)("filters %s on readAt", async (filter, expected) => {
    const { db, findManyArgs } = fakeDb();
    await new NotificationQueryService({ db }).list(currentUser, filter);

    expect((findManyArgs[0]!.where as Record<string, unknown>).readAt).toEqual(expected);
  });

  it("does not filter on readAt for all", async () => {
    const { db, findManyArgs } = fakeDb();
    await new NotificationQueryService({ db }).list(currentUser, "all");

    expect("readAt" in (findManyArgs[0]!.where as Record<string, unknown>)).toBe(false);
  });

  // CONTRACT: window_total is a 90-day count WITHOUT the cap, so it can exceed
  // items.length. That divergence is exactly why the counters are separate.
  it("counts the 90-day window without the cap", async () => {
    const { db, countArgs } = fakeDb([row("ntf_1", null)], { unread: 3, window: 120 });
    const page = await new NotificationQueryService({ db }).list(currentUser, "all");

    expect(page.unread_count).toBe(3);
    expect(page.window_total).toBe(120);
    expect(page.window_total).toBeGreaterThan(page.items.length);

    const windowCall = countArgs.find(
      (args) => (args.where as Record<string, unknown>).readAt !== null,
    );
    expect(JSON.stringify(windowCall!.where)).toContain("createdAt");
  });

  // The unread and window counts are BOTH unfiltered by the requested filter: the
  // pill on the Unread tab must still read the same totals as on All.
  it("keeps both counts independent of the requested filter", async () => {
    const { db, countArgs } = fakeDb([row("ntf_1", null)], { unread: 3, window: 120 });
    const page = await new NotificationQueryService({ db }).list(currentUser, "read");

    expect(page.unread_count).toBe(3);
    expect(page.window_total).toBe(120);
    for (const args of countArgs) {
      expect((args.where as Record<string, unknown>).userId).toBe("usr_alice");
    }
  });

  it("maps rows through toDomain rather than leaking the raw row", async () => {
    const { db } = fakeDb();
    const page = await new NotificationQueryService({ db }).list(currentUser, "all");

    expect(page.items[0]).toEqual({
      id: "ntf_1",
      userId: "usr_alice",
      type: "ORDER_STATUS",
      title: "Your order has shipped",
      body: "ORD-3MRAI-10482 · Handed to the carrier and on its way to you.",
      metadata: { status: "SHIPPED", occurred_at: "2026-08-01T17:48:03" },
      readAt: null,
      createdAt: new Date("2026-08-01T17:48:03Z"),
    });
  });

  it("returns an empty page for a caller with no user row", async () => {
    const { db } = fakeDb();
    const unknown = { identity: "sub-nobody", resolve: async () => null } as never;
    const page = await new NotificationQueryService({ db }).list(unknown, "all");

    expect(page).toEqual({ items: [], unread_count: 0, window_total: 0, window_days: WINDOW_DAYS });
  });
});

describe("NotificationQueryService.unreadCount", () => {
  it("counts only the caller's unread rows", async () => {
    const { db, countArgs } = fakeDb([], { unread: 7, window: 9 });
    const count = await new NotificationQueryService({ db }).unreadCount(currentUser);

    expect(count).toBe(7);
    expect(countArgs[0]!.where).toEqual({ userId: "usr_alice", readAt: null });
  });

  it("returns zero for a caller with no user row", async () => {
    const { db, countArgs } = fakeDb();
    const unknown = { identity: "sub-nobody", resolve: async () => null } as never;

    expect(await new NotificationQueryService({ db }).unreadCount(unknown)).toBe(0);
    expect(countArgs).toHaveLength(0);
  });
});
