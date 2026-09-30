import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { testSpanExporter } from "../setup.ts";
import { appLogger } from "#shared/logging/app-logger";
import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
import { ensureStripeCustomer } from "../../src/payment-methods/ensure-stripe-customer.ts";

function fakeDb(
  user: { stripeCustomerId: string | null; cognitoSub?: string | null },
  options?: { updateManyCount?: number; reread?: { stripeCustomerId: string | null } },
) {
  const findUniqueOrThrow = vi.fn().mockResolvedValueOnce(user).mockResolvedValue(options?.reread ?? user);
  const updateMany = vi.fn().mockImplementation(() => Promise.resolve({ count: options?.updateManyCount ?? 1 }));
  return {
    user: { findUniqueOrThrow, updateMany },
    // CONTRACT: ensureStripeCustomer reads via `$primary()` (see I1 in
    // [[2026-09-19-stripe-payments-design]]) — the fake must expose the same
    // findUniqueOrThrow mock behind it, not a second independent one.
    $primary: () => ({ user: { findUniqueOrThrow } }),
  } as never;
}

function spanNamed(name: string) {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === name);
}

describe("ensureStripeCustomer", () => {
  beforeEach(() => testSpanExporter.reset());

  it("creates a customer once and persists it when none exists", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cus_123", email: "a@b.com" });
    const stripe = { enabled: true, client: { customers: { create } } } as never;
    const db = fakeDb({ stripeCustomerId: null });

    const calls: unknown[] = [];
    const spy = vi.spyOn(appLogger, "info").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);

    const id = await ensureStripeCustomer(stripe, db, {
      userId: "usr_1",
      email: "a@b.com",
      e2eSource: false,
    });

    spy.mockRestore();

    expect(id).toBe("cus_123");
    expect(create).toHaveBeenCalledWith(
      { email: "a@b.com", metadata: { user_id: "usr_1" } },
      { idempotencyKey: "stripe-customer-create-usr_1" },
    );
    expect((db as never as { user: { updateMany: ReturnType<typeof vi.fn> } }).user.updateMany).toHaveBeenCalledWith({
      where: { id: "usr_1", stripeCustomerId: null },
      data: { stripeCustomerId: "cus_123", stripeCustomerData: expect.anything() },
    });

    const successLog = calls.find(
      (args) => (args as [Record<string, unknown>])[0]?.app_event === "stripe_customer_created",
    );
    expect(successLog).toBeDefined();
    const [payload] = successLog as [Record<string, unknown>];
    expect(payload.user_id).toBe("usr_1");
    expect(payload.email_hash).toBeDefined();
    expect(JSON.stringify(payload)).not.toContain("a@b.com");

    const span = spanNamed("stripe.customer.create");
    expect(span).toBeDefined();
    expect(span!.kind).toBe(SpanKind.CLIENT);
    expect(span!.attributes["stripe.resource_type"]).toBe("customer");
    expect(span!.attributes["stripe.customer_id"]).toBe("cus_123");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  it("reuses the existing customer id without calling Stripe again", async () => {
    const create = vi.fn();
    const stripe = { enabled: true, client: { customers: { create } } } as never;
    const db = fakeDb({ stripeCustomerId: "cus_existing" });

    const id = await ensureStripeCustomer(stripe, db, {
      userId: "usr_1",
      email: "a@b.com",
      e2eSource: false,
    });

    expect(id).toBe("cus_existing");
    expect(create).not.toHaveBeenCalled();
    expect(spanNamed("stripe.customer.create")).toBeUndefined();
  });

  it("tags metadata.e2e_source only when e2eSource is true", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cus_e2e" });
    const stripe = { enabled: true, client: { customers: { create } } } as never;
    const db = fakeDb({ stripeCustomerId: null });

    await ensureStripeCustomer(stripe, db, { userId: "usr_1", email: "a@b.com", e2eSource: true });

    expect(create).toHaveBeenCalledWith(
      { email: "a@b.com", metadata: { user_id: "usr_1", e2e_source: "true" } },
      { idempotencyKey: "stripe-customer-create-usr_1" },
    );
  });

  it("sends metadata.cognito_sub from the user row when it has one", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cus_sub" });
    const stripe = { enabled: true, client: { customers: { create } } } as never;
    const db = fakeDb({ stripeCustomerId: null, cognitoSub: "sub-abc" });

    await ensureStripeCustomer(stripe, db, { userId: "usr_1", email: "a@b.com", e2eSource: true });

    expect(create).toHaveBeenCalledWith(
      { email: "a@b.com", metadata: { user_id: "usr_1", cognito_sub: "sub-abc", e2e_source: "true" } },
      { idempotencyKey: "stripe-customer-create-usr_1" },
    );
  });

  it.each([null, ""])("omits metadata.cognito_sub when the user row's sub is %j", async (cognitoSub) => {
    const create = vi.fn().mockResolvedValue({ id: "cus_nosub" });
    const stripe = { enabled: true, client: { customers: { create } } } as never;
    const db = fakeDb({ stripeCustomerId: null, cognitoSub });

    await ensureStripeCustomer(stripe, db, { userId: "usr_1", email: "a@b.com", e2eSource: false });

    const [params] = create.mock.calls[0] as [{ metadata: Record<string, string> }];
    expect(params.metadata).toEqual({ user_id: "usr_1" });
    expect(params.metadata).not.toHaveProperty("cognito_sub");
  });

  it("throws StripeUnavailableException when the client is null", async () => {
    const stripe = { enabled: true, client: null } as never;
    const db = fakeDb({ stripeCustomerId: null });
    await expect(
      ensureStripeCustomer(stripe, db, { userId: "usr_1", email: "a@b.com", e2eSource: false }),
    ).rejects.toBeInstanceOf(StripeUnavailableException);
  });

  it("returns the winner's persisted id and skips the success log when the conditional write loses the race", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cus_loser" });
    const stripe = { enabled: true, client: { customers: { create } } } as never;
    const db = fakeDb(
      { stripeCustomerId: null },
      { updateManyCount: 0, reread: { stripeCustomerId: "cus_winner" } },
    );

    const calls: unknown[] = [];
    const spy = vi.spyOn(appLogger, "info").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);

    const id = await ensureStripeCustomer(stripe, db, {
      userId: "usr_1",
      email: "a@b.com",
      e2eSource: false,
    });

    spy.mockRestore();

    expect(id).toBe("cus_winner");
    const successLog = calls.find(
      (args) => (args as [Record<string, unknown>])[0]?.app_event === "stripe_customer_created",
    );
    expect(successLog).toBeUndefined();
  });

  it("throws instead of returning undefined when the lost-race re-read has no stripeCustomerId", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cus_loser" });
    const stripe = { enabled: true, client: { customers: { create } } } as never;
    const db = fakeDb({ stripeCustomerId: null }, { updateManyCount: 0, reread: { stripeCustomerId: null } });

    await expect(
      ensureStripeCustomer(stripe, db, { userId: "usr_1", email: "a@b.com", e2eSource: false }),
    ).rejects.toThrow(/usr_1/);
  });
});
