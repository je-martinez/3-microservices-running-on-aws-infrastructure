---
title: "Stripe Payments Implementation Plan"
type: plan
area: shared
status: draft
created: 2026-09-19
updated: 2026-09-22
tags: [type/plan, area/shared, status/draft]
propagates-to:
  - "[[2026-09-19-stripe-payments-design]]"
  - "[[testing]]"
  - "[[env-files]]"
  - "[[git-workflow]]"
  - "[[phase-c-review-flow]]"
  - "[[cqrs]]"
  - "[[angular-component-authoring]]"
  - "[[openapi-specs]]"
  - "[[soft-delete]]"
  - "[[audit-fields]]"
  - "[[nano-id]]"
  - "[[money-representation]]"
  - "[[local-dev]]"
  - "[[skills-catalog]]"
  - "[[stripe-sandbox-setup]]"
  - "[[browser-rum]]"
  - "[[logging-context]]"
related:
  - "[[2026-09-19-stripe-payments-design]]"
  - "[[testing]]"
  - "[[env-files]]"
  - "[[git-workflow]]"
  - "[[phase-c-review-flow]]"
  - "[[cqrs]]"
  - "[[angular-component-authoring]]"
  - "[[openapi-specs]]"
  - "[[soft-delete]]"
  - "[[audit-fields]]"
  - "[[nano-id]]"
  - "[[money-representation]]"
  - "[[local-dev]]"
  - "[[skills-catalog]]"
  - "[[stripe-sandbox-setup]]"
  - "[[browser-rum]]"
  - "[[logging-context]]"
---

# Stripe Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing `NG_APP_STRIPE_ENABLED` flag from a static UI swap into a real integration — saved cards on Users, real off-session charges on Orders, and a Payment Element checkout flow on the web app.

**Architecture:** Users owns the Stripe Customer and its PaymentMethods (lazy customer creation, local cache reconciled by webhook); Orders owns the PaymentIntent, fetching `stripe_customer_id` over the existing gRPC contract and charging before persisting, with an automatic refund if the stock reservation 409s after a successful charge. The web app replaces the static "Powered by Stripe" card with a saved-card selector plus the Stripe Payment Element.

**Tech Stack:** Stripe Node SDK 22.6.0 (Users, NestJS/Fastify/Prisma), Stripe .NET SDK 52.4.0 (Orders, Minimal APIs/EF Core), Stripe.js Payment Element (Angular web app), Stripe CLI (`stripe listen`) for local webhook delivery.

**Spec:** `docs/superpowers/specs/2026-09-19-stripe-payments-design.md`

## Global Constraints

- Stripe API version pinned to `2026-08-26.dahlia` (per Decision 18).
- SDKs: Stripe Node SDK **22.6.0** (Users), Stripe .NET SDK **52.4.0** (Orders) (per Decision 18).
- `StripeClient` is instantiated **per-instance** in both services, never the deprecated global/module-level key pattern (`Stripe.setApiKey` / `StripeConfiguration.ApiKey = …`) (per Decision 18).
- Each service uses its own **restricted key** (`rk_...`), one per service, never a secret key (`sk_...`); never logged, never included in error messages, never in the AUTO box of an env file — hand-injected into the CUSTOM box only (per Decisions 13, 15).
- `payment_method_types` is never passed to any Stripe call, on either service (per Decision 16).
- The web app uses the **Payment Element only** — never the legacy Card Element, never the Payment Element restricted to card-only mode (per Decision 16, Web section).
- Prohibited APIs/methods, on either service: the Charges API, the Sources API, the Tokens API, the Card Element, and Stripe.js `createPaymentMethod`/`createToken` (per Decision 16's table).
- `STRIPE_ENABLED=false` is the default, and with it off the whole repo behaves exactly as today — no mounted routes, no Stripe calls, no meaningful migrations triggered at runtime (per the spec's "Flag gate" section).
- pnpm only — never npm/yarn, including for any new sub-project code.
- Run `nvm use` before any Node.js command.
- New scripts are Python by default, per the repo's scripting-language convention.
- Every new or changed HTTP endpoint requires all three test layers — unit/integration, internal E2E, and gateway E2E with a real Cognito JWT — per [[testing]].

## Task 1 — Stripe client foundation in Users

**Files:**
- Create: `services/users/src/shared/stripe/stripe-client.provider.ts`, `services/users/src/shared/stripe/stripe-client.provider.spec.ts`, `services/users/src/shared/tokens.ts` (extend, do not recreate), `services/users/src/shared/observability/stripe-tracing.ts`, `services/users/src/shared/observability/stripe-tracing.spec.ts`
- Modify: `services/users/src/config/env.schema.ts`
- Test: `services/users/src/shared/stripe/stripe-client.provider.spec.ts`, `services/users/src/shared/observability/stripe-tracing.spec.ts`

**Interfaces:**
- Consumes: `services/users/src/config/env.schema.ts`'s existing `E2E_TESTING_ENABLED` boolean-from-string pattern (`z.enum(["true","false"]).default("false").transform((v) => v === "true")`).
- Produces:
  ```ts
  // services/users/src/shared/stripe/stripe-client.provider.ts
  export const STRIPE_CLIENT = Symbol("STRIPE_CLIENT");

  export interface StripeClientHolder {
    /** Null when STRIPE_ENABLED is true but STRIPE_SECRET_KEY is absent (Decision 13). */
    readonly client: StripeClient | null;
    readonly enabled: boolean;
  }
  ```
  Consumed by every later Users task via `@Inject(STRIPE_CLIENT) private readonly stripe: StripeClientHolder`.
  Also produces `withStripeSpan` (`services/users/src/shared/observability/stripe-tracing.ts`,
  step 1.8) — the Stripe analogue of `withPublishSpan`, consumed by Tasks 3, 4, 5, and 6 for
  every outbound Stripe call (spec Decision 25).

### Steps

- [ ] 1.1 Add the two new env vars to `services/users/src/config/env.schema.ts`, mirroring the existing `E2E_TESTING_ENABLED` pattern:
  ```ts
  // Kill switch for the whole Stripe integration (spec D13). Off by default so
  // every existing deploy and every test that doesn't opt in stays untouched.
  STRIPE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // A restricted key (rk_...), never a secret key. Optional: STRIPE_ENABLED=true
  // with this absent is a valid boot state (spec D13) — the Stripe routes then
  // answer 503 instead of taking the service down.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  ```
  Run `nvm use && pnpm --filter users test env.schema` — expect it to fail (no such test file yet is fine; confirm the schema still parses via `pnpm --filter users exec tsc --noEmit`).

- [ ] 1.2 Add `STRIPE_CLIENT` to `services/users/src/shared/tokens.ts` alongside the existing `DB`, `AUTH_PROVIDER`, `EVENT_PUBLISHER` tokens:
  ```ts
  export const STRIPE_CLIENT = Symbol("STRIPE_CLIENT");
  ```

- [ ] 1.3 Write the failing spec first, `services/users/src/shared/stripe/stripe-client.provider.spec.ts`:
  ```ts
  import { describe, expect, it, vi } from "vitest";
  import { buildStripeClientHolder } from "./stripe-client.provider";

  describe("buildStripeClientHolder", () => {
    it("returns a client when enabled and a key is present", () => {
      const holder = buildStripeClientHolder(
        { STRIPE_ENABLED: true, STRIPE_SECRET_KEY: "rk_test_123" },
        { warn: vi.fn() },
      );
      expect(holder.enabled).toBe(true);
      expect(holder.client).not.toBeNull();
    });

    it("returns a null client and logs a warning when enabled with no key", () => {
      const warn = vi.fn();
      const holder = buildStripeClientHolder(
        { STRIPE_ENABLED: true, STRIPE_SECRET_KEY: undefined },
        { warn },
      );
      expect(holder.enabled).toBe(true);
      expect(holder.client).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
    });

    it("returns a null client with no warning when disabled", () => {
      const warn = vi.fn();
      const holder = buildStripeClientHolder(
        { STRIPE_ENABLED: false, STRIPE_SECRET_KEY: undefined },
        { warn },
      );
      expect(holder.enabled).toBe(false);
      expect(holder.client).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    });
  });
  ```
  Run `nvm use && pnpm --filter users test stripe-client.provider` — fails, module does not exist.

- [ ] 1.4 Implement `services/users/src/shared/stripe/stripe-client.provider.ts`:
  ```ts
  import { StripeClient } from "stripe";

  export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

  export interface StripeEnv {
    STRIPE_ENABLED: boolean;
    STRIPE_SECRET_KEY: string | undefined;
  }

  export interface StripeClientHolder {
    readonly client: StripeClient | null;
    readonly enabled: boolean;
  }

  interface WarnLogger {
    warn(message: string): void;
  }

  // CONTRACT: STRIPE_ENABLED=true with no key is a valid boot state (spec D13) —
  // the service still boots; callers check `.client` for null and answer 503.
  export function buildStripeClientHolder(env: StripeEnv, logger: WarnLogger): StripeClientHolder {
    if (!env.STRIPE_ENABLED) {
      return { client: null, enabled: false };
    }
    if (!env.STRIPE_SECRET_KEY) {
      logger.warn(
        "STRIPE_ENABLED is true but STRIPE_SECRET_KEY is not set. Stripe routes will answer 503.",
      );
      return { client: null, enabled: true };
    }
    return {
      client: new StripeClient(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION }),
      enabled: true,
    };
  }
  ```
  Run `nvm use && pnpm --filter users test stripe-client.provider` — passes.

- [ ] 1.5 Wire it as a Nest provider consuming `ConfigService` and `appLogger`, in the same file:
  ```ts
  import { Inject, Injectable } from "@nestjs/common";
  import { ConfigService } from "@nestjs/config";
  import { appLogger } from "#shared/logging/app-logger";

  export const STRIPE_CLIENT = Symbol("STRIPE_CLIENT");

  export const stripeClientProvider = {
    provide: STRIPE_CLIENT,
    inject: [ConfigService],
    useFactory: (config: ConfigService): StripeClientHolder =>
      buildStripeClientHolder(
        {
          STRIPE_ENABLED: config.get<boolean>("STRIPE_ENABLED", false),
          STRIPE_SECRET_KEY: config.get<string | undefined>("STRIPE_SECRET_KEY"),
        },
        appLogger,
      ),
  };
  ```
  Run `nvm use && pnpm --filter users test` (full suite) — passes.

- [ ] 1.6 Add a `StripeUnavailableException` mapped to HTTP 503, `services/users/src/shared/stripe/stripe-unavailable.exception.ts`:
  ```ts
  import { HttpException, HttpStatus } from "@nestjs/common";

  // Thrown by any Stripe-backed route when the client holder's `.client` is
  // null (spec D13) — flag on, key missing. Never thrown when the flag is off;
  // those routes are not mounted at all (see Task 4).
  export class StripeUnavailableException extends HttpException {
    constructor() {
      super("Stripe is not configured on this deployment.", HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
  ```

- [ ] 1.7 **Stripe observability foundation (spec Decision 25).** Write the failing spec first,
  `services/users/src/shared/observability/stripe-tracing.spec.ts`, asserting a span is
  created with the right name/kind/attributes and that a thrown error sets ERROR status:
  ```ts
  import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
  import { describe, expect, it, vi } from "vitest";
  import { withStripeSpan } from "./stripe-tracing";

  describe("withStripeSpan", () => {
    it("names the span after the operation, kind CLIENT, with the given attributes", async () => {
      const result = await withStripeSpan(
        "stripe.customer.create",
        { "stripe.resource_type": "customer" },
        async (handle) => {
          handle.setAttribute("stripe.customer_id", "cus_123");
          return "ok";
        },
      );
      expect(result).toBe("ok");
      // Assert against the in-memory span exporter this repo's other tracing
      // specs already use (grep publish-tracing.spec.ts for the exact harness)
      // rather than reinventing one here.
    });

    it("sets ERROR status and records the exception when fn throws, then still ends the span", async () => {
      await expect(
        withStripeSpan("stripe.payment_method.attach", {}, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      // Assert the exported span's status.code === SpanStatusCode.ERROR and
      // that end() was called exactly once (span left open would fail the
      // exporter assertion in the harness referenced above).
    });
  });
  ```
  Run `nvm use && pnpm --filter users test stripe-tracing` — fails, module missing.

- [ ] 1.8 Implement `services/users/src/shared/observability/stripe-tracing.ts`, the Stripe
  analogue of `withPublishSpan`
  (`services/users/src/shared/observability/publish-tracing.ts`) — same tracer-per-module,
  `startActiveSpan`, attributes built inside the callback, `end()` in a `finally`:
  ```ts
  import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

  // CONTRACT: Named after the OPERATION, not the SDK surface (spec D25) — the
  // name is what a waterfall renders, so it must say what happened. Mirrors
  // withPublishSpan's naming reasoning. See [[logging-context]]
  const tracer = trace.getTracer("users-stripe");

  export interface StripeSpanHandle {
    /** Attach a queryable attribute discovered only inside `fn` (e.g. a Stripe object id). */
    setAttribute(key: string, value: string | number | boolean): void;
  }

  /**
   * Run `fn` inside a CLIENT span named after the Stripe operation (spec D25).
   * CLIENT, not PRODUCER — Stripe is an outbound third-party dependency, not a
   * message publish. `span.end()` stays in a `finally`: a span left open on the
   * exception path is never exported, with nothing to say so. Unlike
   * `withPublishSpan`, a thrown error here IS allowed to propagate (a Stripe
   * call failure is a real failure, not a swallowed best-effort send) — this
   * helper still records it on the span before it does.
   * See [[logging-context]]
   */
  export function withStripeSpan<T>(
    operation: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: StripeSpanHandle) => Promise<T>,
  ): Promise<T> {
    return tracer.startActiveSpan(
      operation,
      {
        kind: SpanKind.CLIENT,
        attributes: { "stripe.operation": operation, ...attributes },
      },
      async (span) => {
        const handle: StripeSpanHandle = {
          setAttribute(key, value) {
            span.setAttribute(key, value);
          },
        };
        try {
          const result = await fn(handle);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          // CONTRACT: Never a plaintext card, key, or client_secret on this
          // span (spec D25) — callers pass only ids/metadata into `attributes`
          // and `setAttribute`, never a raw Stripe response object.
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }
  ```
  Run `nvm use && pnpm --filter users test stripe-tracing` — passes. Every later Users task
  (Tasks 3, 4, 5, 6) wraps its Stripe calls in `withStripeSpan` rather than hand-rolling a span,
  the same way every command in this plan consumes `STRIPE_CLIENT` rather than instantiating
  its own client.

- [ ] 1.9 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 2 — Prisma schema + migration for the Stripe data model

**Files:**
- Modify: `services/users/prisma/schema.prisma`
- Create: a Prisma migration under `services/users/prisma/migrations/`
- Test: `services/users/src/shared/db/prisma-extensions.spec.ts` (extend, if it covers new models) or a new `services/users/src/features/payment-methods/stripe-payment-method.model.spec.ts`

**Interfaces:**
- Produces the `StripePaymentMethod` Prisma model and `User.stripeCustomerId` / `User.stripeCustomerData` columns consumed by Tasks 3–6.

### Steps

- [ ] 2.1 Add the two new columns to `model User` in `services/users/prisma/schema.prisma`, next to the existing `mustChangePassword` block:
  ```prisma
    // Lazily created (spec D2) — null until the first checkout or card-add with
    // the Stripe flag on. Stripe is authoritative; this is a cache (spec D4).
    stripeCustomerId   String? @unique @map("stripe_customer_id")
    stripeCustomerData Json?   @map("stripe_customer_data")
  ```
  and add the relation:
  ```prisma
    stripePaymentMethods StripePaymentMethod[]
  ```

- [ ] 2.2 Add the new model, following the exact shape of `UsersCognitoData` for audit fields, plus [[soft-delete]] and [[nano-id]]:
  ```prisma
  // Local cache of a Stripe PaymentMethod, mirroring the fields Stripe actually
  // exposes (spec D3) — never a raw PAN/CVC, which never reach this service by
  // Stripe's own design. Stripe is authoritative (spec D4): a webhook upserts
  // this row, and a card deleted in Stripe is soft-deleted here, never
  // hard-deleted, so historical orders referencing it still resolve.
  model StripePaymentMethod {
    id                    String    @id
    stripePaymentMethodId String    @unique @map("stripe_payment_method_id")
    userId                String    @map("user_id")
    brand                 String
    last4                 String
    expMonth              Int       @map("exp_month")
    expYear               Int       @map("exp_year")
    funding               String
    country                String?
    fingerprint           String?
    billingName           String?   @map("billing_name")
    billingEmail          String?   @map("billing_email")
    billingAddress        Json?     @map("billing_address")
    isDefault             Boolean   @default(false) @map("is_default")
    rawPayload            Json      @map("raw_payload")

    createdBy DateTime? @map("created_by")
    createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
    updatedBy String?   @map("updated_by")
    updatedAt DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
    deletedBy String?   @map("deleted_by")
    deletedAt DateTime? @map("deleted_at") @db.Timestamptz(6)

    user User @relation(fields: [userId], references: [id])

    @@map("stripe_payment_methods")
    @@index([userId, deletedAt])
  }
  ```
  Fix the copy-paste typo before running anything: `createdBy` must be `String?`, not `DateTime?` — correct it to `createdBy String? @map("created_by")` to match the repo's audit-fields convention.

- [ ] 2.3 Run the migration: `nvm use && pnpm --filter users exec prisma migrate dev --name add_stripe_customer_and_payment_methods`. Confirm it applies cleanly against the local dev database and that `stripeCustomerId`/`stripeCustomerData` are nullable so every existing `users` row is unaffected.

- [ ] 2.4 Write a test proving the flag-off case is inert, `services/users/src/features/payment-methods/stripe-payment-method.model.spec.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { createTestDb } from "#shared/testing/test-db";

  describe("StripePaymentMethod migration", () => {
    it("leaves existing users rows with null stripe columns", async () => {
      const db = await createTestDb();
      const user = await db.user.findFirst();
      expect(user?.stripeCustomerId ?? null).toBeNull();
    });
  });
  ```
  Run `nvm use && pnpm --filter users test stripe-payment-method.model` — passes (adjust the test-db helper import to whatever this repo's existing integration tests use; do not invent a new one — grep for `createTestDb`/similar helpers already used by `register.command.spec.ts` before writing this step for real).

- [ ] 2.5 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 3 — `ensureStripeCustomer` (lazy creation)

**Files:**
- Create: `services/users/src/features/payment-methods/ensure-stripe-customer.ts`, `services/users/src/features/payment-methods/ensure-stripe-customer.spec.ts`
- Test: `services/users/src/features/payment-methods/ensure-stripe-customer.spec.ts`

**Interfaces:**
- Consumes: `STRIPE_CLIENT` (`StripeClientHolder`, Task 1), `DB` (`Db`, Prisma client with `stripeCustomerId`/`stripeCustomerData`, Task 2).
- Produces:
  ```ts
  export interface EnsureStripeCustomerInput {
    userId: string;
    email: string;
    e2eSource: boolean; // true only when x-e2e-source header AND E2E_TESTING_ENABLED
  }

  export async function ensureStripeCustomer(
    stripe: StripeClientHolder,
    db: Db,
    input: EnsureStripeCustomerInput,
  ): Promise<string>; // returns stripeCustomerId, throws StripeUnavailableException if stripe.client is null
  ```
  Consumed by Task 4 (setup-intent route) and Task 9 (Orders, indirectly via gRPC).

### Steps

- [ ] 3.1 Write the failing spec, `services/users/src/features/payment-methods/ensure-stripe-customer.spec.ts`:
  ```ts
  import { describe, expect, it, vi } from "vitest";
  import { ensureStripeCustomer } from "./ensure-stripe-customer";
  import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";

  function fakeDb(user: { stripeCustomerId: string | null }) {
    return {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(user),
        update: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...user, ...data })),
      },
    } as any;
  }

  describe("ensureStripeCustomer", () => {
    it("creates a customer once and persists it when none exists", async () => {
      const create = vi.fn().mockResolvedValue({ id: "cus_123", email: "a@b.com" });
      const stripe = { enabled: true, client: { customers: { create } } } as any;
      const db = fakeDb({ stripeCustomerId: null });

      const id = await ensureStripeCustomer(stripe, db, {
        userId: "usr_1",
        email: "a@b.com",
        e2eSource: false,
      });

      expect(id).toBe("cus_123");
      expect(create).toHaveBeenCalledWith({
        email: "a@b.com",
        metadata: { user_id: "usr_1" },
      });
      expect(db.user.update).toHaveBeenCalledOnce();
    });

    it("reuses the existing customer id without calling Stripe again", async () => {
      const create = vi.fn();
      const stripe = { enabled: true, client: { customers: { create } } } as any;
      const db = fakeDb({ stripeCustomerId: "cus_existing" });

      const id = await ensureStripeCustomer(stripe, db, {
        userId: "usr_1",
        email: "a@b.com",
        e2eSource: false,
      });

      expect(id).toBe("cus_existing");
      expect(create).not.toHaveBeenCalled();
    });

    it("tags metadata.e2e_source only when e2eSource is true", async () => {
      const create = vi.fn().mockResolvedValue({ id: "cus_e2e" });
      const stripe = { enabled: true, client: { customers: { create } } } as any;
      const db = fakeDb({ stripeCustomerId: null });

      await ensureStripeCustomer(stripe, db, { userId: "usr_1", email: "a@b.com", e2eSource: true });

      expect(create).toHaveBeenCalledWith({
        email: "a@b.com",
        metadata: { user_id: "usr_1", e2e_source: "true" },
      });
    });

    it("throws StripeUnavailableException when the client is null", async () => {
      const stripe = { enabled: true, client: null } as any;
      const db = fakeDb({ stripeCustomerId: null });
      await expect(
        ensureStripeCustomer(stripe, db, { userId: "usr_1", email: "a@b.com", e2eSource: false }),
      ).rejects.toBeInstanceOf(StripeUnavailableException);
    });
  });
  ```
  Run `nvm use && pnpm --filter users test ensure-stripe-customer` — fails, module missing.

- [ ] 3.2 Implement `services/users/src/features/payment-methods/ensure-stripe-customer.ts`:
  ```ts
  import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
  import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
  import type { Db } from "#shared/db/prisma";

  export interface EnsureStripeCustomerInput {
    userId: string;
    email: string;
    e2eSource: boolean;
  }

  // Idempotent (spec D2): returns the existing stripeCustomerId when present,
  // otherwise creates one and persists it. Called lazily — never from
  // registration — so a Stripe outage never blocks sign-up.
  export async function ensureStripeCustomer(
    stripe: StripeClientHolder,
    db: Db,
    input: EnsureStripeCustomerInput,
  ): Promise<string> {
    if (!stripe.client) throw new StripeUnavailableException();

    const user = await db.user.findUniqueOrThrow({ where: { id: input.userId } });
    if (user.stripeCustomerId) return user.stripeCustomerId;

    const metadata: Record<string, string> = { user_id: input.userId };
    if (input.e2eSource) metadata.e2e_source = "true";

    const customer = await stripe.client.customers.create({ email: input.email, metadata });

    await db.user.update({
      where: { id: input.userId },
      data: { stripeCustomerId: customer.id, stripeCustomerData: customer as unknown as object },
    });

    return customer.id;
  }
  ```
  Run `nvm use && pnpm --filter users test ensure-stripe-customer` — passes.

- [ ] 3.3 **Wrap the Stripe call in `withStripeSpan` and emit the flow log (spec Decision
  25).** Extend 3.2's implementation: the `stripe.client.customers.create` call moves inside
  `withStripeSpan("stripe.customer.create", { "stripe.resource_type": "customer" }, ...)`,
  setting `stripe.customer_id` via the handle once the customer comes back, and the function
  logs `app_event=stripe_customer_created` (INFO) with `user_id` and `email_hash` (never the
  raw email — [[logging-context]]) after the DB write succeeds:
  ```ts
  import { withStripeSpan } from "#shared/observability/stripe-tracing";
  import { hashEmail } from "#shared/auth/hash-email"; // use this service's existing hasher
  import { appLogger } from "#shared/logging/app-logger";

  // ... inside ensureStripeCustomer, replacing the bare `stripe.client.customers.create` call:
  const customer = await withStripeSpan(
    "stripe.customer.create",
    { "stripe.resource_type": "customer" },
    async (span) => {
      const created = await stripe.client!.customers.create({ email: input.email, metadata });
      span.setAttribute("stripe.customer_id", created.id);
      return created;
    },
  );

  await db.user.update({
    where: { id: input.userId },
    data: { stripeCustomerId: customer.id, stripeCustomerData: customer as unknown as object },
  });

  appLogger.info(
    { app_event: "stripe_customer_created", user_id: input.userId, email_hash: hashEmail(input.email) },
    "Stripe customer created",
  );
  ```
  Add a spec assertion that the log call happens with `app_event: "stripe_customer_created"`
  and no `email` field, using this service's existing logger-mock pattern (grep an existing
  `appLogger` spy in another command spec before writing this assertion for real). Run
  `nvm use && pnpm --filter users test ensure-stripe-customer` — passes.

- [ ] 3.4 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 4 — Users payment-method commands/queries (CQRS)

**Files:**
- Create: `services/users/src/features/payment-methods/commands/create-setup-intent.command.ts`, `.../commands/attach-payment-method.command.ts`, `.../commands/detach-payment-method.command.ts`, `.../commands/set-default-payment-method.command.ts`, `.../queries/list-payment-methods.query.ts`, plus a `.spec.ts` per handler, `services/users/src/features/payment-methods/payment-methods.controller.ts`, `services/users/src/features/payment-methods/payment-methods.module.ts`
- Modify: `services/users/openapi.yaml`
- Test: one `.spec.ts` per command/query handler, dispatched through the real `CommandBus`/`QueryBus`

**Interfaces:**
- Consumes: `ensureStripeCustomer` (Task 3), `STRIPE_CLIENT` (Task 1), `StripePaymentMethod` Prisma model (Task 2).
- Produces the five routes below, consumed by Task 5 (webhook, same table), Task 6 (e2e-cleanup), and Task 11 (web app):
  - `POST /v1/users/me/payment-methods/setup-intent`
  - `GET /v1/users/me/payment-methods`
  - `POST /v1/users/me/payment-methods`
  - `DELETE /v1/users/me/payment-methods/:id`
  - `PUT /v1/users/me/payment-methods/:id/default`

### Steps

- [ ] 4.1 Write the failing spec for the setup-intent command, `create-setup-intent.command.spec.ts`, dispatched through `CommandBus` per [[cqrs]]:
  ```ts
  import { Test } from "@nestjs/testing";
  import { CqrsModule, CommandBus } from "@nestjs/cqrs";
  import { describe, expect, it, vi } from "vitest";
  import { CreateSetupIntentCommand, CreateSetupIntentHandler } from "./create-setup-intent.command";
  import { DB, STRIPE_CLIENT } from "#shared/tokens";

  describe("CreateSetupIntentHandler", () => {
    it("ensures the customer then creates a SetupIntent and returns its client_secret", async () => {
      const create = vi.fn().mockResolvedValue({ client_secret: "seti_123_secret_abc" });
      const stripeHolder = {
        enabled: true,
        client: {
          customers: { create: vi.fn().mockResolvedValue({ id: "cus_1" }) },
          setupIntents: { create },
        },
      };
      const db = {
        user: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "usr_1", email: "a@b.com", stripeCustomerId: "cus_1" }),
          update: vi.fn(),
        },
      };

      const moduleRef = await Test.createTestingModule({
        imports: [CqrsModule],
        providers: [
          CreateSetupIntentHandler,
          { provide: DB, useValue: db },
          { provide: STRIPE_CLIENT, useValue: stripeHolder },
        ],
      }).compile();
      await moduleRef.init();

      const commandBus = moduleRef.get(CommandBus);
      const result = await commandBus.execute(
        new CreateSetupIntentCommand({ userId: "usr_1", e2eSource: false }),
      );

      expect(result).toEqual({ clientSecret: "seti_123_secret_abc" });
      expect(create).toHaveBeenCalledWith({ customer: "cus_1" });
    });
  });
  ```
  Run `nvm use && pnpm --filter users test create-setup-intent.command` — fails, module missing.

- [ ] 4.2 Implement `create-setup-intent.command.ts`:
  ```ts
  import { Inject } from "@nestjs/common";
  import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
  import type { Db } from "#shared/db/prisma";
  import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
  import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
  import { DB, STRIPE_CLIENT } from "#shared/tokens";
  import { ensureStripeCustomer } from "../ensure-stripe-customer";

  export interface CreateSetupIntentInput {
    userId: string;
    e2eSource: boolean;
  }

  export class CreateSetupIntentCommand {
    constructor(public readonly input: CreateSetupIntentInput) {}
  }

  export interface CreateSetupIntentResult {
    clientSecret: string;
  }

  @CommandHandler(CreateSetupIntentCommand)
  export class CreateSetupIntentHandler implements ICommandHandler<CreateSetupIntentCommand> {
    constructor(
      @Inject(DB) private readonly db: Db,
      @Inject(STRIPE_CLIENT) private readonly stripe: StripeClientHolder,
    ) {}

    async execute({ input }: CreateSetupIntentCommand): Promise<CreateSetupIntentResult> {
      if (!this.stripe.client) throw new StripeUnavailableException();

      const user = await this.db.user.findUniqueOrThrow({ where: { id: input.userId } });
      const customerId = await ensureStripeCustomer(this.stripe, this.db, {
        userId: input.userId,
        email: user.email,
        e2eSource: input.e2eSource,
      });

      // No payment_method_types (spec D16) — dynamic payment methods stay enabled.
      const setupIntent = await this.stripe.client.setupIntents.create({ customer: customerId });
      if (!setupIntent.client_secret) throw new Error("Stripe did not return a client_secret");
      return { clientSecret: setupIntent.client_secret };
    }
  }
  ```
  Run `nvm use && pnpm --filter users test create-setup-intent.command` — passes.

- [ ] 4.3 Write the failing spec for listing, `list-payment-methods.query.spec.ts`, then implement `list-payment-methods.query.ts` reading only the local `StripePaymentMethod` table (never Stripe — spec D4: "listing reads local"):
  ```ts
  // list-payment-methods.query.ts
  import { Inject } from "@nestjs/common";
  import { type IQueryHandler, QueryHandler } from "@nestjs/cqrs";
  import type { Db } from "#shared/db/prisma";
  import { DB } from "#shared/tokens";

  export class ListPaymentMethodsQuery {
    constructor(public readonly userId: string) {}
  }

  export interface PaymentMethodView {
    id: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    isDefault: boolean;
  }

  @QueryHandler(ListPaymentMethodsQuery)
  export class ListPaymentMethodsHandler implements IQueryHandler<ListPaymentMethodsQuery> {
    constructor(@Inject(DB) private readonly db: Db) {}

    async execute({ userId }: ListPaymentMethodsQuery): Promise<PaymentMethodView[]> {
      const rows = await this.db.stripePaymentMethod.findMany({
        where: { userId, deletedAt: null },
        orderBy: { isDefault: "desc" },
      });
      return rows.map((r) => ({
        id: r.stripePaymentMethodId,
        brand: r.brand,
        last4: r.last4,
        expMonth: r.expMonth,
        expYear: r.expYear,
        isDefault: r.isDefault,
      }));
    }
  }
  ```
  Run `nvm use && pnpm --filter users test list-payment-methods.query` — passes once test doubles are added mirroring 4.1's shape.

- [ ] 4.4 Write the failing spec for attach, `attach-payment-method.command.spec.ts`, then implement `attach-payment-method.command.ts`. This is the confirm-and-persist route (`POST /v1/users/me/payment-methods`), taking the tokenized `pm_...` from the confirmed SetupIntent, attaching it to the customer, and writing the local row in the same response (spec D3, D11):
  ```ts
  // attach-payment-method.command.ts
  import { Inject } from "@nestjs/common";
  import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
  import type { Db } from "#shared/db/prisma";
  import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
  import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
  import { DB, STRIPE_CLIENT } from "#shared/tokens";
  import { MODEL_ID_PREFIXES, generateId } from "#shared/id/nano-id";

  export interface AttachPaymentMethodInput {
    userId: string;
    paymentMethodId: string; // pm_...
    e2eSource: boolean;
  }

  export class AttachPaymentMethodCommand {
    constructor(public readonly input: AttachPaymentMethodInput) {}
  }

  @CommandHandler(AttachPaymentMethodCommand)
  export class AttachPaymentMethodHandler implements ICommandHandler<AttachPaymentMethodCommand> {
    constructor(
      @Inject(DB) private readonly db: Db,
      @Inject(STRIPE_CLIENT) private readonly stripe: StripeClientHolder,
    ) {}

    async execute({ input }: AttachPaymentMethodCommand) {
      if (!this.stripe.client) throw new StripeUnavailableException();

      const user = await this.db.user.findUniqueOrThrow({ where: { id: input.userId } });
      if (!user.stripeCustomerId) throw new Error("Customer must exist before attaching a card");

      const pm = await this.stripe.client.paymentMethods.attach(input.paymentMethodId, {
        customer: user.stripeCustomerId,
      });

      const row = await this.db.stripePaymentMethod.create({
        data: {
          id: generateId(MODEL_ID_PREFIXES.stripePaymentMethod),
          stripePaymentMethodId: pm.id,
          userId: input.userId,
          brand: pm.card?.brand ?? "unknown",
          last4: pm.card?.last4 ?? "0000",
          expMonth: pm.card?.exp_month ?? 0,
          expYear: pm.card?.exp_year ?? 0,
          funding: pm.card?.funding ?? "unknown",
          country: pm.card?.country ?? null,
          fingerprint: pm.card?.fingerprint ?? null,
          billingName: pm.billing_details?.name ?? null,
          billingEmail: pm.billing_details?.email ?? null,
          billingAddress: pm.billing_details?.address ?? null,
          isDefault: false,
          rawPayload: pm as unknown as object,
        },
      });

      return { id: row.stripePaymentMethodId };
    }
  }
  ```
  Add `stripePaymentMethod: "stpm"` to `MODEL_ID_PREFIXES` in `services/users/src/shared/id/nano-id.ts` per [[nano-id]]'s registered-prefix table.

- [ ] 4.5 Write the failing spec for detach, `detach-payment-method.command.spec.ts`, asserting **ownership**: a `pm_...` belonging to another user's customer is rejected before any Stripe call:
  ```ts
  it("rejects a payment method that does not belong to the caller", async () => {
    const db = {
      stripePaymentMethod: {
        findFirst: vi.fn().mockResolvedValue(null), // scoped by userId + stripePaymentMethodId
      },
    };
    const stripe = { enabled: true, client: { paymentMethods: { detach: vi.fn() } } };
    const handler = new DetachPaymentMethodHandler(db as any, stripe as any);

    await expect(
      handler.execute(
        new DetachPaymentMethodCommand({ userId: "usr_1", paymentMethodId: "pm_other_user" }),
      ),
    ).rejects.toThrow(/not found/i);
    expect(stripe.client.paymentMethods.detach).not.toHaveBeenCalled();
  });
  ```
  Then implement `detach-payment-method.command.ts`:
  ```ts
  import { Inject, NotFoundException } from "@nestjs/common";
  import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
  import type { Db } from "#shared/db/prisma";
  import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
  import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
  import { DB, STRIPE_CLIENT } from "#shared/tokens";

  export interface DetachPaymentMethodInput {
    userId: string;
    paymentMethodId: string;
  }

  export class DetachPaymentMethodCommand {
    constructor(public readonly input: DetachPaymentMethodInput) {}
  }

  @CommandHandler(DetachPaymentMethodCommand)
  export class DetachPaymentMethodHandler implements ICommandHandler<DetachPaymentMethodCommand> {
    constructor(
      @Inject(DB) private readonly db: Db,
      @Inject(STRIPE_CLIENT) private readonly stripe: StripeClientHolder,
    ) {}

    async execute({ input }: DetachPaymentMethodCommand): Promise<void> {
      if (!this.stripe.client) throw new StripeUnavailableException();

      // CONTRACT: Scoped by userId AND stripePaymentMethodId — without this,
      // passing another user's pm_... id would detach and soft-delete their
      // card (spec "Users HTTP surface", ownership requirement).
      const row = await this.db.stripePaymentMethod.findFirst({
        where: { userId: input.userId, stripePaymentMethodId: input.paymentMethodId, deletedAt: null },
      });
      if (!row) throw new NotFoundException("Payment method not found");

      await this.stripe.client.paymentMethods.detach(input.paymentMethodId);
      await this.db.stripePaymentMethod.update({
        where: { id: row.id },
        data: { deletedAt: new Date() },
      });
    }
  }
  ```
  Run `nvm use && pnpm --filter users test detach-payment-method.command` — passes.

- [ ] 4.6 Write the failing spec for set-default, `set-default-payment-method.command.spec.ts`, with the same ownership check, then implement `set-default-payment-method.command.ts` calling `stripe.client.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } })` and mirroring `isDefault` locally (unset on all other rows for that user, set on this one, inside a `db.$transaction`).

- [ ] 4.7 Create the controller `payment-methods.controller.ts`, dispatching through `CommandBus`/`QueryBus` per [[cqrs]] — the controller binds the request, checks auth (existing `x-user-id`/JWT guard pattern already used by other Users controllers), and calls exactly one handler; no domain logic or Prisma calls inline:
  ```ts
  import { Body, Controller, Delete, Get, Headers, Param, Post, Put, UseGuards } from "@nestjs/common";
  import { CommandBus, QueryBus } from "@nestjs/cqrs";
  import { CurrentUser } from "#shared/auth/current-user.decorator";
  import { AuthGuard } from "#shared/auth/auth.guard";
  import { CreateSetupIntentCommand } from "./commands/create-setup-intent.command";
  import { AttachPaymentMethodCommand } from "./commands/attach-payment-method.command";
  import { DetachPaymentMethodCommand } from "./commands/detach-payment-method.command";
  import { SetDefaultPaymentMethodCommand } from "./commands/set-default-payment-method.command";
  import { ListPaymentMethodsQuery } from "./queries/list-payment-methods.query";

  @UseGuards(AuthGuard)
  @Controller("v1/users/me/payment-methods")
  export class PaymentMethodsController {
    constructor(
      private readonly commandBus: CommandBus,
      private readonly queryBus: QueryBus,
    ) {}

    @Post("setup-intent")
    createSetupIntent(@CurrentUser() userId: string, @Headers("x-e2e-source") e2eSource?: string) {
      return this.commandBus.execute(
        new CreateSetupIntentCommand({ userId, e2eSource: e2eSource === "true" }),
      );
    }

    @Get()
    list(@CurrentUser() userId: string) {
      return this.queryBus.execute(new ListPaymentMethodsQuery(userId));
    }

    @Post()
    attach(
      @CurrentUser() userId: string,
      @Body("paymentMethodId") paymentMethodId: string,
      @Headers("x-e2e-source") e2eSource?: string,
    ) {
      return this.commandBus.execute(
        new AttachPaymentMethodCommand({ userId, paymentMethodId, e2eSource: e2eSource === "true" }),
      );
    }

    @Delete(":id")
    detach(@CurrentUser() userId: string, @Param("id") paymentMethodId: string) {
      return this.commandBus.execute(new DetachPaymentMethodCommand({ userId, paymentMethodId }));
    }

    @Put(":id/default")
    setDefault(@CurrentUser() userId: string, @Param("id") paymentMethodId: string) {
      return this.commandBus.execute(new SetDefaultPaymentMethodCommand({ userId, paymentMethodId }));
    }
  }
  ```
  Note: `@CurrentUser()`, `AuthGuard`, and the exact request-binding decorators must match whatever this service's existing authenticated controllers already use (e.g. `users.controller.ts`'s `GET /v1/users/me`) — copy that file's decorator names verbatim rather than the placeholders shown here if they differ.

- [ ] 4.8 Register `PaymentMethodsController` and all five handlers in a new `payment-methods.module.ts`, and import it into the app module **only when `STRIPE_ENABLED` is true** (conditional module registration, or a guard inside each route per Task 1's `StripeUnavailableException` — pick whichever mechanism this NestJS version's existing conditional-module precedent uses; if none exists, mount unconditionally and rely on `StripeUnavailableException`/503 from Task 1, since the spec's requirement is "not mounted when off" as the intent, and 503-on-every-call is an acceptable literal reading only if true conditional mounting isn't already precedented in this codebase — confirm against `env.schema.ts` consumers before choosing).

- [ ] 4.9 Update `services/users/openapi.yaml` per [[openapi-specs]], adding all five paths under `/v1/users/me/payment-methods*` with request/response schemas matching the interfaces above.

- [ ] 4.10 **Wrap each handler's Stripe call in `withStripeSpan` and emit its flow log (spec
  Decision 25).** Extend each of 4.2–4.6's implementations, one call site each:
  - `CreateSetupIntentHandler` — `withStripeSpan("stripe.setup_intent.create", {
    "stripe.resource_type": "setup_intent" }, ...)` around `setupIntents.create`, then
    `app_event=payment_intent_created` is NOT emitted here (that name is reserved for Orders'
    PaymentIntent, Task 9) — this route logs nothing beyond the span; a SetupIntent with no
    subsequent attach carries no useful flow event of its own.
  - `AttachPaymentMethodHandler` — `withStripeSpan("stripe.payment_method.attach", {
    "stripe.resource_type": "payment_method" }, ...)` around `paymentMethods.attach`, setting
    `stripe.payment_method_id` via the handle, then `app_event=payment_method_attached` (INFO)
    with `user_id` after the local row is written.
  - `DetachPaymentMethodHandler` — `withStripeSpan("stripe.payment_method.detach", {
    "stripe.resource_type": "payment_method", "stripe.payment_method_id": input.paymentMethodId
    }, ...)` around `paymentMethods.detach`, then `app_event=payment_method_detached` (INFO)
    with `user_id`.
  - `SetDefaultPaymentMethodHandler` — `withStripeSpan("stripe.customer.update", {
    "stripe.resource_type": "customer" }, ...)` around `customers.update`, then
    `app_event=payment_method_set_default` (INFO) with `user_id`.
  - Every one of the four failure paths logs `app_event=<flow>_failed` with `reason` **before**
    rethrowing — do not let `withStripeSpan`'s own ERROR-status recording substitute for the
    flow log; the span and the log carry the same `app_event`/`reason` per [[logging-context]],
    neither replaces the other.
  Add one spec assertion per handler (extending 4.1's, 4.4's, 4.5's, and a new one for
  set-default) that the expected `app_event` is logged on success. Run
  `nvm use && pnpm --filter users test` (payment-methods handlers) — passes.

- [ ] 4.11 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 5 — Stripe webhook endpoint (reconciliation)

**Files:**
- Create: `services/users/src/features/payment-methods/stripe-webhook.controller.ts`, `services/users/src/features/payment-methods/commands/reconcile-payment-method.command.ts`, `.spec.ts` for both
- Modify: `services/users/openapi.yaml`

**Interfaces:**
- Consumes: `STRIPE_CLIENT` (Task 1, for `stripe.webhooks.constructEvent`), `StripePaymentMethod` model (Task 2).
- Produces: `POST /v1/users/stripe/webhook` (public, unauthenticated by JWT, signature-verified).

### Steps

- [ ] 5.1 Write the failing spec asserting signature rejection BEFORE any processing, `stripe-webhook.controller.spec.ts`:
  ```ts
  it("returns 400 and never dispatches a command when the signature is invalid", async () => {
    const commandBus = { execute: vi.fn() };
    const stripe = {
      enabled: true,
      client: {
        webhooks: {
          constructEvent: vi.fn().mockImplementation(() => {
            throw new Error("No signatures found matching the expected signature");
          }),
        },
      },
    };
    const controller = new StripeWebhookController(stripe as any, commandBus as any, "whsec_test");

    await expect(
      controller.handle(Buffer.from("{}"), "bad-signature"),
    ).rejects.toThrow(/signature/i);
    expect(commandBus.execute).not.toHaveBeenCalled();
  });
  ```
  Run `nvm use && pnpm --filter users test stripe-webhook.controller` — fails, module missing.

- [ ] 5.2 Implement `stripe-webhook.controller.ts`. It must receive the **raw** request body (Fastify raw-body plugin, matching whatever this service already uses for the existing `POST /v1/webhooks/cognito` — copy that route's raw-body wiring verbatim rather than reinventing it):
  ```ts
  import { BadRequestException, Body, Controller, Headers, Inject, Post } from "@nestjs/common";
  import { CommandBus } from "@nestjs/cqrs";
  import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
  import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
  import { STRIPE_CLIENT } from "#shared/tokens";
  import { ReconcilePaymentMethodCommand } from "./commands/reconcile-payment-method.command";

  const RECONCILED_TYPES = new Set([
    "payment_method.attached",
    "payment_method.detached",
    "payment_method.updated",
    "payment_method.automatically_updated",
    "customer.updated",
  ]);

  @Controller("v1/users/stripe")
  export class StripeWebhookController {
    constructor(
      @Inject(STRIPE_CLIENT) private readonly stripe: StripeClientHolder,
      private readonly commandBus: CommandBus,
      private readonly webhookSecret: string,
    ) {}

    @Post("webhook")
    async handle(@Body() rawBody: Buffer, @Headers("stripe-signature") signature: string) {
      if (!this.stripe.client) throw new StripeUnavailableException();

      let event;
      try {
        event = this.stripe.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
      } catch (err) {
        // CONTRACT: Verify BEFORE processing (spec D4) — never dispatch a
        // command from an unverified payload.
        throw new BadRequestException(`Webhook signature verification failed: ${(err as Error).message}`);
      }

      if (RECONCILED_TYPES.has(event.type)) {
        await this.commandBus.execute(new ReconcilePaymentMethodCommand(event));
      }
      return { received: true };
    }
  }
  ```
  Run `nvm use && pnpm --filter users test stripe-webhook.controller` — passes.

- [ ] 5.3 Write the failing spec for `reconcile-payment-method.command.ts`, asserting: `payment_method.detached` and `customer.updated` with no matching `default_payment_method` soft-delete/no-op appropriately, and `payment_method.attached`/`updated`/`automatically_updated` upsert the local row (never hard-delete). Then implement it using `db.stripePaymentMethod.upsert` keyed on `stripePaymentMethodId`, and on `detached`, soft-delete (`deletedAt: new Date()`) rather than removing the row — per Decision 4's "never hard-deleted".

- [ ] 5.4 Add `POST /v1/users/stripe/webhook` to `services/users/openapi.yaml` per [[openapi-specs]], documented as public/unauthenticated with a `stripe-signature` header requirement.

- [ ] 5.5 **Emit `stripe_webhook_received` and log signature failures without the signature or
  body (spec Decision 25).** Extend 5.2's `handle` method: on successful `constructEvent`, log
  `app_event=stripe_webhook_received` (INFO) with `event.type` and `event.id` as fields, before
  dispatching to `commandBus`. On the signature-verification catch branch (already present in
  5.2), log `app_event=stripe_webhook_received` at WARN/ERROR with
  `reason=signature_verification_failed` — **never** the `stripe-signature` header value or the
  raw body, matching the `BadRequestException` message's own restraint (it already carries only
  Stripe's error message, not the payload). Add a spec assertion that the failure-path log call
  contains neither the literal signature string nor a `body`/`rawBody` field:
  ```ts
  it("logs stripe_webhook_received with reason=signature_verification_failed, never the signature or body", async () => {
    const logSpy = vi.spyOn(appLogger, "warn");
    // ... invoke handle() with the bad-signature fixture from 5.1 ...
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ app_event: "stripe_webhook_received", reason: "signature_verification_failed" }),
      expect.any(String),
    );
    const loggedPayload = JSON.stringify(logSpy.mock.calls[0]);
    expect(loggedPayload).not.toContain("bad-signature");
  });
  ```
  Run `nvm use && pnpm --filter users test stripe-webhook.controller` — passes.

- [ ] 5.6 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 6 — Extend `e2e-cleanup` to Stripe

**Files:**
- Modify: the existing e2e-cleanup command/handler (locate via `grep -rn "e2e-cleanup" services/users/src`) and its spec.

**Interfaces:**
- Consumes: `STRIPE_CLIENT` (Task 1), `withStripeSpan` (Task 1.8), `User.stripeCustomerId` (Task 2).

### Steps

- [ ] 6.1 Read the existing `DELETE /v1/users/e2e-cleanup` handler in full before editing — locate it with `grep -rln "e2e-cleanup\|E2eCleanup" services/users/src`.

- [ ] 6.2 Write a failing spec asserting that, for every user row carrying `"E2E Source"` with a non-null `stripeCustomerId`, `stripe.client.customers.del(stripeCustomerId)` is called, and that a user with no `stripeCustomerId` is skipped without error (Stripe never called for it).

- [ ] 6.3 Implement: extend the existing handler to, after (or alongside) its current soft-delete pass, iterate tagged rows with a `stripeCustomerId` and call `stripe.client.customers.del(...)` wrapped in `withStripeSpan("stripe.customer.delete", { "stripe.resource_type": "customer" }, ...)` (spec Decision 25 — this is still an outbound Stripe call and gets the same span treatment as every other one in this plan), guarding with `if (!this.stripe.client) return;` at the top so cleanup is a no-op when Stripe isn't configured, never a failure. No new `app_event` is introduced for this path — e2e-cleanup is test-only infrastructure, not a user-facing flow, so the span alone (for debugging a stuck CI sandbox) is sufficient per Decision 25's scope.

- [ ] 6.4 Run `nvm use && pnpm --filter users test` (full suite) — confirm nothing else broke.

- [ ] 6.5 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 7 — gRPC: `stripe_customer_id` on `UserResponse`

**Files:**
- Modify: `proto/users.proto`, the Users Node gRPC server handler (`grep -rln "UserResponse" services/users/src`), the Orders .NET gRPC client consumer (`grep -rln "UserResponse" services/orders/src`)

**Interfaces:**
- Produces: `UserResponse.stripe_customer_id` (field 6), consumed by Task 9.

### Steps

- [ ] 7.1 Add field 6 to `proto/users.proto`'s `UserResponse`:
  ```proto
  message UserResponse {
    string id = 1;
    string email = 2;
    string full_name = 3;
    string cognito_sub = 4;
    Address address = 5;
    // Null Stripe customer serializes as "" (proto3 has no null for strings).
    // NOT exposed on GET /v1/users/me (spec D6) — this field exists only for
    // Orders' server-to-server lookup.
    string stripe_customer_id = 6;
  }
  ```

- [ ] 7.2 Regenerate/hand-update the Users Node gRPC server's `GetUserById` handler to populate `stripe_customer_id: user.stripeCustomerId ?? ""`, matching the existing empty-string-for-absent convention documented in the proto file's `Address` comment.

- [ ] 7.3 Regenerate/hand-update the Orders .NET gRPC client consumer to read `response.StripeCustomerId` (empty string means "no Stripe customer yet" — Orders must treat `""` as null/absent, never call Stripe with it).

- [ ] 7.4 Write or extend a unit test on each side: Users' gRPC handler spec asserts `stripe_customer_id` round-trips correctly for both a set and an unset `stripeCustomerId`; Orders' gRPC client test asserts an empty string maps to `null`/absent in its own `IUserDirectory` DTO.

- [ ] 7.5 Run `nvm use && pnpm --filter users test` and (from `services/orders`) `dotnet test` — confirm both pass.

- [ ] 7.6 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## GATE — stop point before Orders work

Tasks 1–7 complete the Users side of this milestone; it is independently testable end to end (Tasks 1–6 unit-tested, Task 7 changes a shared contract both services compile against). **Present the batch of task→feature PRs for Tasks 1–7 for review now, per [[phase-c-review-flow]]** — do not continue to Task 9 until this batch is merged, because Task 9 (Orders) consumes Task 7's proto change and must build on merged work, not a local unmerged copy. Do not ask for a merge confirmation between each of Tasks 1–7 individually; chain them, then stop here with the whole batch.

## Task 9 — Orders: PaymentIntent on order creation

**Files:**
- Modify: `services/orders/src/Orders.Api/Program.cs` (StripeClient registration + `AddSource("orders-stripe")`), the order-creation endpoint and its command handler (`grep -rln "POST.*orders\|CreateOrder" services/orders/src/Orders.Api`), `services/orders/src/Orders.Domain` (payment snapshot fields on the order aggregate)
- Create: an EF Core migration for the payment snapshot columns, a second EF Core migration for
  the `IdempotencyKey` column + unique index (step 9.10b),
  `services/orders/src/Orders.Infrastructure/Observability/StripeActivitySource.cs`
- Test: xUnit tests for the order-creation handler (mocking `StripeClient`), `Testcontainers-MySQL` integration test, observability assertions per step 9.10, idempotency-key tests per step 9.10b

**Interfaces:**
- Consumes: `UserResponse.stripe_customer_id` (Task 7), `paymentMethodId` in the `POST /v1/orders` request body (new field), `Idempotency-Key` request header (new, required when `STRIPE_ENABLED=true` — step 9.10b).
- Produces:
  ```csharp
  public sealed record PaymentSnapshot(
      string PaymentIntentId,
      string PaymentStatus,
      long AmountCents,
      string Currency,
      string PaymentMethodId,
      string? CardBrand,
      string? CardLast4,
      int? CardExpMonth,
      int? CardExpYear,
      string PaymentRawPayload);
  ```
  Consumed by Task 10 (refund path) and the order read models.

### Steps

- [ ] 9.1 Register `StripeClient` as a per-instance singleton in `Program.cs`, next to the existing gRPC client registration block, reading the key via `builder.Configuration["STRIPE_SECRET_KEY"]` following the exact fail-fast-with-generation-escape shape already used for `EVENTS_TOPIC_ARN`:
  ```csharp
  // Stripe (spec D18): per-instance StripeClient, never the deprecated global
  // StripeConfiguration.ApiKey pattern. STRIPE_ENABLED gates whether it charges
  // at all; a missing key with the flag on must not take the service down
  // (spec D13) — routes answer 402/503 at call time, not at boot.
  var stripeEnabled = builder.Configuration.GetValue("STRIPE_ENABLED", false);
  var stripeSecretKey = builder.Configuration["STRIPE_SECRET_KEY"];
  builder.Services.AddSingleton(_ =>
      stripeSecretKey is null
          ? null
          : new StripeClient(stripeSecretKey, new StripeClientOptions { ApiVersion = "2026-08-26.dahlia" }));
  builder.Services.AddSingleton(new StripeSettings(stripeEnabled));
  ```
  where `StripeSettings` is a small new record `public sealed record StripeSettings(bool Enabled);` in `Orders.Api`.
  In the same edit, register the new `orders-stripe` activity source (spec Decision 25, step
  9.10) alongside the existing `AddSource("orders-messaging")`/`AddSource("orders-workflow")`
  calls in `Program.cs`'s OTel setup — an unregistered source creates spans that are silently
  never exported, same trap `WorkflowTracer`'s and `SnsEventPublisher`'s comments already warn
  about: `.WithTracing(tracing => tracing.AddSource("orders-stripe"))`.

- [ ] 9.2 Add the EF Core migration for the payment snapshot columns on the order aggregate (`PaymentIntentId`, `PaymentStatus`, `AmountCents`, `Currency`, `PaymentMethodId`, `CardBrand`, `CardLast4`, `CardExpMonth`, `CardExpYear`, `PaymentRawPayload`), all nullable so existing orders are unaffected: `dotnet ef migrations add AddStripePaymentSnapshot --project services/orders/src/Orders.Infrastructure --startup-project services/orders/src/Orders.Api`.

- [ ] 9.3 Write the failing xUnit test for the 400-when-missing case:
  ```csharp
  [Fact]
  public async Task CreateOrder_WithStripeEnabledAndNoPaymentMethodId_Returns400()
  {
      var factory = _factory.WithStripeEnabled(true);
      var client = factory.CreateClient();
      client.DefaultRequestHeaders.Add("x-user-id", "cognito-sub-1");

      var response = await client.PostAsJsonAsync("/v1/orders", new { lines = new[] { new { productId = "prd_1", quantity = 1 } } });

      Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
  }
  ```
  Run `dotnet test --filter CreateOrder_WithStripeEnabledAndNoPaymentMethodId_Returns400` — fails (endpoint doesn't validate this yet).

- [ ] 9.4 Write the failing xUnit test for the flag-off passthrough:
  ```csharp
  [Fact]
  public async Task CreateOrder_WithStripeDisabled_IgnoresPaymentMethodIdAndSucceeds()
  {
      var factory = _factory.WithStripeEnabled(false);
      var client = factory.CreateClient();
      client.DefaultRequestHeaders.Add("x-user-id", "cognito-sub-1");

      var response = await client.PostAsJsonAsync("/v1/orders", new { lines = new[] { new { productId = "prd_1", quantity = 1 } } });

      response.EnsureSuccessStatusCode();
  }
  ```

- [ ] 9.5 Write the failing xUnit test for the charge-then-persist happy path, mocking `StripeClient`'s `PaymentIntentService.CreateAsync` to return a succeeded PaymentIntent, and asserting: (a) `off_session: true, confirm: true` were passed, (b) `payment_method_types` was NOT set on the request options, (c) the idempotency key passed equals a value derived from the order id generated before the call, (d) the persisted order carries the full payment snapshot, (e) the order is persisted only AFTER the charge call returns (assert via call-order on the mocks, e.g. a `Sequence`/`InSequence` verification if this repo's test doubles support it, or by asserting the charge mock throws and no order row is written — see 9.6).

- [ ] 9.6 Write the failing xUnit test for a card error, mocking `StripeClient` to throw a `Stripe.StripeException` with `StripeError.Code == "card_declined"`, and asserting the endpoint returns 402 with Stripe's message in the body, and that **no order row was persisted**.

- [ ] 9.7 Implement the order-creation handler changes:
  ```csharp
  public sealed record CreateOrderInput(IReadOnlyList<OrderLineInput> Lines, string? PaymentMethodId);

  // Inside the command handler, after computing pricing (existing OrderPricing
  // call) and before persisting:
  if (_stripeSettings.Enabled)
  {
      if (string.IsNullOrEmpty(input.PaymentMethodId))
          throw new OrderValidationException("paymentMethodId is required when Stripe is enabled.");

      var stripeCustomerId = await _userDirectory.GetStripeCustomerIdAsync(caller.Sub, ct);
      var orderId = _idGenerator.NewOrderId(); // generated BEFORE charging, so the idempotency key is stable across retries

      PaymentIntent paymentIntent;
      try
      {
          var service = new PaymentIntentService(_stripeClient);
          paymentIntent = await service.CreateAsync(
              new PaymentIntentCreateOptions
              {
                  Amount = pricing.TotalCents,
                  Currency = "usd",
                  Customer = stripeCustomerId,
                  PaymentMethod = input.PaymentMethodId,
                  OffSession = true,
                  Confirm = true,
                  Metadata = new Dictionary<string, string> { ["order_id"] = orderId },
                  // No PaymentMethodTypes (spec D16) — dynamic payment methods stay enabled.
              },
              new RequestOptions { IdempotencyKey = $"order-charge-{orderId}" },
              ct);
      }
      catch (StripeException ex)
      {
          // WHY: A decline/insufficient-funds/expired-card is not a server
          // fault — it must reach the frontend as an actionable message
          // (spec D8), not a 500. No order row is written on this path.
          throw new PaymentDeclinedException(ex.StripeError?.Message ?? "Your card was declined.");
      }

      order.ApplyPaymentSnapshot(new PaymentSnapshot(
          paymentIntent.Id,
          paymentIntent.Status,
          pricing.TotalCents,
          "usd",
          input.PaymentMethodId,
          paymentIntent.PaymentMethod?.Card?.Brand,
          paymentIntent.PaymentMethod?.Card?.Last4,
          (int?)paymentIntent.PaymentMethod?.Card?.ExpMonth,
          (int?)paymentIntent.PaymentMethod?.Card?.ExpYear,
          JsonSerializer.Serialize(paymentIntent)));
  }
  // Persist happens here, after the above block — charge-then-persist (spec D7).
  ```
  Map `PaymentDeclinedException` to HTTP 402 in the existing exception-to-status-code middleware (locate it via `grep -rln "StatusCodes.Status4" services/orders/src/Orders.Api`, follow its existing pattern for mapping a domain exception to a status code — e.g. however the existing 409 stock-conflict exception is mapped).

- [ ] 9.8 Run `dotnet test` for all of Tasks 9.3–9.6's tests — confirm they now pass.

- [ ] 9.9 **Server-side metadata-only card validation (Decision 21).** With `STRIPE_ENABLED=false` (plain branch), the frontend now sends `brand`, `last4`, `expMonth`, `expYear` alongside the order body (Task 11a wires this). Orders receives **no PAN and no CVC** — this validation exists so the rule is enforced in both places, not because the client's check is untrusted with card data it never had access to the sensitive parts of anyway. Write the failing xUnit test first:
  ```csharp
  [Theory]
  [InlineData("unknown_brand_xyz", "4242", 12, 2099, false)] // unknown brand rejected server-side
  [InlineData("visa", "42", 12, 2099, false)]                // last4 not exactly 4 digits
  [InlineData("visa", "4242", 1, 2020, false)]                // expired
  [InlineData("visa", "4242", 12, 2099, true)]                // valid
  public async Task CreateOrder_ValidatesCardMetadata_WhenStripeDisabled(
      string brand, string last4, int expMonth, int expYear, bool expectSuccess)
  {
      var factory = _factory.WithStripeEnabled(false);
      var client = factory.CreateClient();
      client.DefaultRequestHeaders.Add("x-user-id", "cognito-sub-1");

      var response = await client.PostAsJsonAsync("/v1/orders", new
      {
          lines = new[] { new { productId = "prd_1", quantity = 1 } },
          card = new { brand, last4, expMonth, expYear },
      });

      Assert.Equal(expectSuccess ? HttpStatusCode.Created : HttpStatusCode.BadRequest, response.StatusCode);
  }
  ```
  Implement a small pure validator (no Stripe dependency, since this path never touches Stripe):
  ```csharp
  public static class CardMetadataValidator
  {
      private static readonly HashSet<string> KnownBrands = new(StringComparer.OrdinalIgnoreCase)
      {
          "visa", "mastercard", "amex", "discover", "diners", "jcb", "unknown",
      };

      public static bool IsValid(string brand, string last4, int expMonth, int expYear, DateOnly today)
      {
          if (!KnownBrands.Contains(brand)) return false;
          if (last4.Length != 4 || !last4.All(char.IsDigit)) return false;
          if (expMonth < 1 || expMonth > 12) return false;
          var lastDayOfExpiryMonth = new DateOnly(expYear, expMonth, DateTime.DaysInMonth(expYear, expMonth));
          return lastDayOfExpiryMonth >= today;
      }
  }
  ```
  Call it from the order-creation handler, only on the plain branch (`if (!_stripeSettings.Enabled)`), returning 400 when it fails, before any persistence. Run `dotnet test` — passes. This validator takes NO PaymentIntent/Stripe dependency, unlike Task 9's charging block — it is a pure metadata check, distinct from and unrelated to whether Stripe is configured.

- [ ] 9.10 **Wrap the PaymentIntent call in a CLIENT `Activity` and emit the flow logs (spec
  Decision 25).** Before writing this step, check for an existing outbound-hop tracing helper
  in `services/orders/src/` (`grep -rln "ActivitySource\|StartActivity" services/orders/src`)
  and mirror it — `Orders.Infrastructure/Messaging/SnsEventPublisher.cs`'s
  `ActivitySource`/manual try-catch-finally shape is the reference here (this repo's .NET side
  has no `withPublishSpan`-style generic helper; `SnsEventPublisher` inlines its own
  `ActivitySource`, and Stripe's outbound hop follows the same shape rather than introducing a
  new abstraction this milestone does not need). Add a dedicated `ActivitySource` to
  `Orders.Infrastructure/Observability/` (do not reuse `SnsEventPublisher`'s — a different hop
  gets its own source name, the same way `orders-messaging` and `orders-workflow` are already
  two separate ones):
  ```csharp
  namespace Orders.Infrastructure.Observability;

  // CONTRACT: Program.cs's AddSource(...) must name this EXACT string, mirroring
  // WorkflowTracer/SnsEventPublisher's existing sources — an unregistered source
  // creates spans that are silently never exported. See [[ADR-0019-distributed-tracing-opentelemetry]]
  public static class StripeActivitySource
  {
      public const string Name = "orders-stripe";
      public static readonly ActivitySource Source = new(Name);
  }
  ```
  Wrap the `PaymentIntentService.CreateAsync` call from step 9.7 in a CLIENT activity, named
  after the operation per spec Decision 25 (`stripe.payment_intent.create`, not
  `PaymentIntentService.CreateAsync`):
  ```csharp
  using var activity = StripeActivitySource.Source.StartActivity(
      "stripe.payment_intent.create", ActivityKind.Client);
  activity?.SetTag("stripe.operation", "stripe.payment_intent.create");
  activity?.SetTag("stripe.resource_type", "payment_intent");
  activity?.SetTag("stripe.idempotency_key", $"order-charge-{orderId}"); // spec D25 — needed for a retry investigation

  try
  {
      paymentIntent = await service.CreateAsync(/* ... 9.7's options ... */, ct);
      activity?.SetTag("stripe.payment_intent_id", paymentIntent.Id);
      activity?.SetStatus(ActivityStatusCode.Ok);

      _logger.LogInformation(
          "PaymentIntent created and charged {app_event} {order_id} {payment_intent_id}",
          "payment_charged", orderId, paymentIntent.Id);
  }
  catch (StripeException ex)
  {
      // WHY: A decline is a business outcome, not a server fault (spec D8/D25)
      // — INFO/WARN with the decline_code as `reason`, never ERROR. An ERROR
      // span here would put an ordinary declined card on the same dashboard as
      // a real fault. The activity itself still records the exception, because
      // it genuinely failed as a Stripe CLIENT call — only the LOG severity is
      // downgraded, deliberately, from what the span records.
      activity?.AddException(ex);
      activity?.SetStatus(ActivityStatusCode.Error, ex.Message);

      _logger.LogWarning(
          "Card declined {app_event} {reason} {order_id}",
          "payment_declined", ex.StripeError?.DeclineCode ?? ex.StripeError?.Code ?? "unknown", orderId);

      throw new PaymentDeclinedException(ex.StripeError?.Message ?? "Your card was declined.");
  }
  ```
  Never place the raw `paymentIntent`/`ex.StripeError` object, the `client_secret`, or the
  restricted key on the activity or in either log call (spec Decision 25; [[logging-context]]'s
  span-attribute rule). Write a unit test asserting: (a) a successful charge logs
  `app_event=payment_charged` at INFO with `order_id` and `payment_intent_id`; (b) a
  `StripeException` with `DeclineCode` set logs `app_event=payment_declined` at **Warning**,
  never Error, with that `decline_code` as `reason`; (c) the activity's tag set never includes a
  field named `client_secret` or `raw_payload`. Run `dotnet test` — passes.

- [ ] 9.10b **Client-supplied `Idempotency-Key` (spec Decision 7, user decision 2026-09-22).**
  A server-minted order id cannot make a retry idempotent — a re-POST mints a new id, so the
  key must come from the client. Migration first: add a nullable `IdempotencyKey` column plus a
  unique index on `(UserId, IdempotencyKey)`:
  `dotnet ef migrations add AddOrderIdempotencyKey --project services/orders/src/Orders.Infrastructure --startup-project services/orders/src/Orders.Api`.

  Write the failing tests first, each asserting exactly one branch of Decision 7:
  - [ ] 9.10b.1 Missing `Idempotency-Key` header with `STRIPE_ENABLED=true` → `400
    idempotency_key_required`. Header absent with the flag off → succeeds exactly as today
    (header ignored).
  - [ ] 9.10b.2 Same `(user, key)` POSTed twice with an identical body → the **first** call
    charges once; the **second** call returns the existing order (`200`, same body) and
    `PaymentIntentService.CreateAsync` is asserted **not called** a second time.
  - [ ] 9.10b.3 Concurrent duplicate requests (same `(user, key)`, fired together) → exactly
    one order is persisted and exactly one Stripe charge is made; the request that loses the
    unique-index race also returns the existing order rather than erroring — assert this with
    a test that forces the race (e.g. two handler invocations against the same in-memory/test
    DB context, or however this repo's existing unique-constraint races are tested; grep first).
  - [ ] 9.10b.4 Replay of an already-refunded PaymentIntent: Stripe returns
    `Idempotent-Replayed: true` for a key whose PaymentIntent was refunded by Task 10's path →
    Orders persists **no** order and answers `409 idempotency_key_reused`.
  - [ ] 9.10b.5 Same key, different request body → Stripe's `idempotency_error` is mapped to
    `422 idempotency_key_mismatch`.

  Implement:
  - The `Idempotency-Key` header is required (flag on) / optional-and-ignored (flag off),
    validated for presence before any Stripe call — mirror however `paymentMethodId`'s
    required-when-enabled check (step 9.3) is structured.
  - Before charging, look up `(UserId, IdempotencyKey)`; if an order exists, return it directly
    (no Stripe call).
  - The Stripe idempotency key passed to `PaymentIntentCreateOptions`'s `RequestOptions`
    becomes `$"order-charge-{userId}-{clientKey}"`, replacing step 9.7's
    `$"order-charge-{orderId}"` — derived from `(user id, client key)`, not the server-minted
    order id, so a retried or concurrent request with the same client key reaches the same
    PaymentIntent.
  - Persist `IdempotencyKey` on the order row alongside the payment snapshot.
  - Detect an `Idempotent-Replayed` response whose PaymentIntent status reflects a prior refund
    (Task 10) and answer 409 `idempotency_key_reused` without persisting an order.
  - Map Stripe's `idempotency_error` to `422 idempotency_key_mismatch` in the same
    exception-to-status-code middleware step 9.7 already extended for `PaymentDeclinedException`.

  Wrap the idempotency-key lookup and the two new error paths in the same `stripe.payment_intent.create`
  activity from step 9.10 — add `stripe.idempotency_key` as a tag (already specified in step
  9.10; this step supplies its real value). Run `dotnet test` — all of 9.10b.1–9.10b.5 pass, and
  the 9.3–9.6/9.9 suite still passes with the new required header added to those tests' requests.

- [ ] 9.11 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 10 — Orders: refund on any post-charge failure

**Widened scope (spec Decision 9, user decision 2026-09-22):** the automatic refund is not
limited to a stock-reservation 409. It covers **any** failure between a successful charge and a
committed order — a 409 under the lock, a product removed from under the reservation, the
price-mismatch guard rejecting a stale total, or a persistence/commit failure — because in every
one of these the charge already succeeded and must never be left dangling. The refund uses its
**own** idempotency key derived from the PaymentIntent id (`refund-{paymentIntentId}`),
independent of Task 9.10b's order-creation key, so a retried refund attempt cannot double-refund.
This task's original name ("refund-on-409") undersold the scope; the steps below cover the 409
case as the primary test and note the other failure modes share the same refund path.

**Files:**
- Modify: the same order-creation handler from Task 9
- Test: a dedicated xUnit test forcing the reservation to fail after a successful charge, plus
  one test per other post-charge failure mode (product removed, price-mismatch guard,
  persistence/commit failure) confirming each also triggers the same refund path

**Interfaces:**
- Consumes: `PaymentSnapshot` (Task 9), `StripeActivitySource` (Task 9.10), the existing stock-reservation call that can return 409, and whatever other post-charge failure paths already exist (price-mismatch guard, persistence/commit).

> [!warning] Highest-risk task in this plan
> This is the repo's known review failure mode per [[phase-c-review-flow]] and [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]: a concurrency requirement specified from day one, shipped as an unhandled path, passing its own review because the diff is self-consistent on its own terms. **Reviewers must tick this task off against Decision 9 in the spec directly, not just read the diff** — ordinary tests structurally do not exercise concurrency, so the only proof this works is the explicit test in step 10.1, not the absence of a crash elsewhere. Per spec Decision 25, this is also the path that must be answerable from the logs alone — step 10.4's `app_event=payment_refunded` line, not just the refund call succeeding, is what makes "was the dangling charge actually refunded?" answerable without opening Stripe's dashboard.

### Steps

- [ ] 10.1 Write the failing xUnit test that forces the exact failure sequence: charge succeeds, THEN the stock reservation call returns 409, and assert a refund was issued for the exact `PaymentIntentId` charged:
  ```csharp
  [Fact]
  public async Task CreateOrder_WhenReservationConflictsAfterSuccessfulCharge_RefundsTheCharge()
  {
      var stripeClientMock = new Mock<StripeClient>(/* ... */);
      // Charge succeeds:
      stripeClientMock
          .Setup(c => /* PaymentIntentService.CreateAsync */)
          .ReturnsAsync(new PaymentIntent { Id = "pi_123", Status = "succeeded" });
      // Refund is expected once, for pi_123:
      var refundServiceMock = new Mock<IRefundService>();

      var factory = _factory
          .WithStripeEnabled(true)
          .WithStripeClient(stripeClientMock.Object)
          .WithReservationThatConflictsAfterCharge(); // test seam forcing a 409 from stock reservation
      var client = factory.CreateClient();
      client.DefaultRequestHeaders.Add("x-user-id", "cognito-sub-1");

      var response = await client.PostAsJsonAsync("/v1/orders", new
      {
          lines = new[] { new { productId = "prd_1", quantity = 1 } },
          paymentMethodId = "pm_test",
      });

      Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
      refundServiceMock.Verify(r => r.RefundAsync("pi_123", It.IsAny<CancellationToken>()), Times.Once);
  }
  ```
  The exact seam for `WithReservationThatConflictsAfterCharge()` must be added to the existing `WebApplicationFactory` test fixture — locate the stock-reservation call site first (`grep -rln "409\|StockReservation\|Conflict" services/orders/src/Orders.Domain services/orders/src/Orders.Infrastructure`) and add a way to inject a reservation service that throws a conflict exception, mirroring however this repo's existing 409 test (if any) already fakes that failure.
  Run `dotnet test --filter CreateOrder_WhenReservationConflictsAfterSuccessfulCharge_RefundsTheCharge` — fails, no refund logic exists yet.

- [ ] 10.2 Implement the refund path in the order-creation handler, wrapping the reservation call in a try/catch that runs only when a charge has already succeeded in this request:
  ```csharp
  PaymentIntent? paymentIntent = null;
  if (_stripeSettings.Enabled)
  {
      paymentIntent = await ChargeAsync(input, pricing, ct); // Task 9's block, extracted
  }

  try
  {
      await _reservationService.ReserveAsync(input.Lines, ct);
  }
  catch (StockConflictException)
  {
      if (paymentIntent is not null)
      {
          // CONTRACT: A charge must never be left dangling (spec D9, widened
          // 2026-09-22). This same catch/refund path also covers a removed
          // product, the price-mismatch guard, and a persistence/commit
          // failure after a successful charge — not only a stock conflict. A
          // reservation conflict occurring BEFORE any charge (Stripe
          // disabled, or reservation checked first in some other flow) has
          // nothing to refund.
          var refundService = new RefundService(_stripeClient);
          await refundService.CreateAsync(
              new RefundCreateOptions
              {
                  PaymentIntent = paymentIntent.Id,
              },
              // Own idempotency key, derived from the PaymentIntent id — independent
              // of the order-creation key (step 9.10b) — so a retried refund attempt
              // cannot double-refund.
              new RequestOptions { IdempotencyKey = $"refund-{paymentIntent.Id}" },
              cancellationToken: ct);
      }
      throw;
  }
  ```
  The same `try`/`catch (StockConflictException)` block must be extended, or paralleled with
  identical `catch` clauses, for the other post-charge failure types this task's widened scope
  covers: a "product removed" exception, the price-mismatch guard's exception type, and a
  persistence/commit failure thrown by the final save — locate each type via
  `grep -rn "ProductRemoved\|PriceMismatch\|class.*Exception" services/orders/src/Orders.Domain`
  and route each into the same refund block (extract it into a private
  `RefundDanglingChargeAsync(paymentIntent, ct)` helper once more than one `catch` needs it,
  rather than duplicating the refund call inline per exception type).

- [ ] 10.2b Write failing xUnit tests for the other post-charge failure modes, one per type
  (product removed after charge, price-mismatch guard after charge, persistence/commit failure
  after charge), each asserting a refund was issued for the exact `PaymentIntentId` charged —
  mirroring step 10.1's shape but forcing a different exception after the charge succeeds. Also
  add a test asserting the refund call's `RequestOptions.IdempotencyKey` equals
  `refund-{paymentIntentId}` (not derived from the order id), and a test that calling the same
  failure path twice for the same PaymentIntent (e.g. a retried request hitting the same
  post-charge failure again) issues the refund only once, proving the refund's own idempotency
  key does its job. Run `dotnet test` — fails until 10.2's implementation covers these paths.

- [ ] 10.3 Run `dotnet test --filter CreateOrder_WhenReservationConflictsAfterSuccessfulCharge_RefundsTheCharge` — passes. Then run the full `dotnet test` suite for `services/orders`, including the new 10.2b tests — confirm no regression on the 9.3–9.6 tests.

- [ ] 10.4 **The refund gets its own span and its own `app_event`, observable independently of
  the charge (spec Decision 25).** This is the highest-risk path in the whole milestone (see
  this task's header warning) precisely because it must be answerable from the logs alone —
  "was a dangling charge actually refunded?" cannot depend on also finding the original charge
  line. Wrap 10.2's `refundService.CreateAsync` call in its own CLIENT activity from the same
  `StripeActivitySource` step 9.10 registered, named `stripe.refund.create`, tagging
  `stripe.payment_intent_id` with the id being refunded, and log
  `app_event=payment_refunded` (INFO) carrying **both** `order_id` and `payment_intent_id` on
  success:
  ```csharp
  using var refundActivity = StripeActivitySource.Source.StartActivity(
      "stripe.refund.create", ActivityKind.Client);
  refundActivity?.SetTag("stripe.operation", "stripe.refund.create");
  refundActivity?.SetTag("stripe.resource_type", "refund");
  refundActivity?.SetTag("stripe.payment_intent_id", paymentIntent.Id);

  try
  {
      var refundService = new RefundService(_stripeClient);
      await refundService.CreateAsync(
          new RefundCreateOptions { PaymentIntent = paymentIntent.Id },
          // Own idempotency key (step 10.2) — independent of the order-creation
          // key (step 9.10b) — so a retried refund attempt cannot double-refund.
          new RequestOptions { IdempotencyKey = $"refund-{paymentIntent.Id}" },
          cancellationToken: ct);
      refundActivity?.SetStatus(ActivityStatusCode.Ok);

      // CONTRACT: Carries BOTH ids on purpose — this line must answer "was the
      // dangling charge refunded?" on its own, without cross-referencing the
      // payment_charged line from a different point in the same request.
      _logger.LogInformation(
          "Charge refunded after a post-charge failure {app_event} {order_id} {payment_intent_id}",
          "payment_refunded", orderId, paymentIntent.Id);
  }
  catch (Exception ex)
  {
      // WHY: A refund that itself fails leaves a REAL dangling charge — this
      // must be loud. ERROR here is correct, unlike the decline path in Task 9.
      refundActivity?.AddException(ex);
      refundActivity?.SetStatus(ActivityStatusCode.Error, ex.Message);
      _logger.LogError(
          ex,
          "Refund FAILED after a post-charge failure — charge left dangling {app_event} {reason} {order_id} {payment_intent_id}",
          "payment_refunded_failed", "refund_call_failed", orderId, paymentIntent.Id);
      throw;
  }
  ```
  Extend 10.1's test (or add a sibling) asserting the success case logs
  `app_event=payment_refunded` with both `order_id` and `payment_intent_id` present on the same
  log line — the assertion this task's header warning exists to make un-skippable: reviewing
  the diff against Decision 9 means confirming this line exists, not just that
  `RefundAsync`/`CreateAsync` was called. Run `dotnet test` — passes.

- [ ] 10.5 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## GATE — stop point before Web work

Task 11 (web) posts `paymentMethodId` to `POST /v1/orders`, which does not behave correctly until Tasks 9–10 are merged. **Present the Tasks 9–10 batch for review per [[phase-c-review-flow]] and wait for merge before starting Task 11.** Task 13 (plain-branch card validation) touches only pure functions and the plain branch — it does not depend on Tasks 9–10 and may be implemented in parallel with this wait. Task 12 (profile Payment methods tab) reuses Task 11's `SavedCardRow`/`PaymentMethodsApi`, so it must wait for Task 11 to land first, not merely for this GATE — see Task 12's header note. All three of Tasks 11, 12, and 13's PRs are batched together for review at this same stop point, since all touch `checkout-payment.html`/`.ts`, `profile.ts`/`.html`, or a component either composes.

## Task 11 — Web: `SavedCardRow` component + Payment Element checkout flow

**Files:**
- Modify: `apps/web/src/env.d.ts`, `apps/web/src/app/core/config/app-config.ts`, `apps/web/src/app/features/checkout/checkout-payment.ts`, `apps/web/src/app/features/checkout/checkout-payment.html`, `docker-compose.yml`, `apps/web/Dockerfile`, `infra/environments/local/scripts/generate_env_files.py`
- Create: `apps/web/src/app/shared/ui/saved-card-row.ts` (+ `.html`), `apps/web/src/app/features/checkout/payment-method-selector.ts` (+ `.html`), `apps/web/src/app/features/checkout/new-card-block.ts` (+ `.html`), `apps/web/src/app/core/api/payment-methods-api.ts`
- Test: `saved-card-row.spec.ts`, component specs for `payment-method-selector` and `new-card-block`, an updated spec for `checkout-payment`

**Interfaces:**
- Consumes: `GET/POST/DELETE/PUT /v1/users/me/payment-methods*` (Task 4), `POST /v1/orders` with `paymentMethodId` and the `Idempotency-Key` header (Task 9, step 9.10b).
- Produces:
  ```ts
  // apps/web/src/app/shared/ui/saved-card-row.ts — vPwZ1 in the .pen, reused
  // by Task 12's profile Cards List. Building it twice per surface is the
  // failure this component-first step prevents.
  export interface SavedCardView {
    id: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  }

  @Component({ selector: 'app-saved-card-row', templateUrl: './saved-card-row.html', changeDetection: ChangeDetectionStrategy.OnPush })
  export class SavedCardRow {
    readonly card = input.required<SavedCardView>();
    readonly selected = input(false);
    readonly isDefault = input(false);
    readonly expired = input(false);

    readonly select = output<string>();     // emits card().id
    readonly setDefault = output<string>();
    readonly remove = output<string>();
  }
  ```
  `APP_CONFIG.stripePublishableKey: string | null`, consumed only inside `checkout-payment.ts`/`payment-method-selector.ts`. `SavedCardRow` and `PaymentMethodsApi` (this task) are also consumed by Task 12 (profile Payment methods tab), which must therefore be ordered after this task.

### Steps

- [ ] 11.1 Write the failing spec for `saved-card-row.spec.ts`, covering the three visual states from the design's Cards List (spec Web section / Decision 24). Verify the exact emitted utility names against `apps/web/src/styles.css` before writing assertions — don't trust the spelling below if `DESIGN.md`'s table has drifted:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { TestBed } from '@angular/core/testing';
  import { SavedCardRow } from './saved-card-row';

  describe('SavedCardRow', () => {
    function render(props: Partial<{ selected: boolean; isDefault: boolean; expired: boolean }>) {
      const fixture = TestBed.createComponent(SavedCardRow);
      fixture.componentRef.setInput('card', { id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2028 });
      fixture.componentRef.setInput('selected', props.selected ?? false);
      fixture.componentRef.setInput('isDefault', props.isDefault ?? false);
      fixture.componentRef.setInput('expired', props.expired ?? false);
      fixture.detectChanges();
      return fixture;
    }

    it('selected + default: bg-surface-subtle fill, border-brand-navy stroke, no "Set as default" link', () => {
      const fixture = render({ selected: true, isDefault: true });
      const root: HTMLElement = fixture.nativeElement.querySelector('[data-testid="saved-card-row"]');
      expect(root.className).toContain('bg-surface-subtle');
      expect(root.className).toContain('border-brand-navy');
      expect(fixture.nativeElement.querySelector('[data-testid="set-default-link"]')).toBeNull();
    });

    it('unselected, not default: transparent fill, border-line stroke, "Set as default" link shown', () => {
      const fixture = render({ selected: false, isDefault: false });
      const root: HTMLElement = fixture.nativeElement.querySelector('[data-testid="saved-card-row"]');
      expect(root.className).toContain('border-line');
      expect(root.className).not.toContain('border-brand-navy');
      expect(fixture.nativeElement.querySelector('[data-testid="set-default-link"]')).not.toBeNull();
    });

    it('expired: danger-red semibold expiry text, dimmed brand bubble, cannot be selected', () => {
      const fixture = render({ expired: true });
      const expiry: HTMLElement = fixture.nativeElement.querySelector('[data-testid="card-expiry"]');
      expect(expiry.textContent).toContain('Expired');
      expect(expiry.className).toContain('text-danger-red');
      expect(expiry.className).toContain('font-semibold');
      const bubble: HTMLElement = fixture.nativeElement.querySelector('[data-testid="brand-bubble"]');
      expect(bubble.className).toContain('bg-surface-subtle');
      const radio: HTMLElement = fixture.nativeElement.querySelector('[data-testid="radio"]');
      expect(radio.getAttribute('aria-disabled')).toBe('true');
    });
  });
  ```
  Run `nvm use && pnpm --filter web test saved-card-row` — fails, module missing.

- [ ] 11.2 Implement `saved-card-row.ts`/`.html` per [[angular-component-authoring]] (sibling `.html` via `templateUrl`, `rem` not `px` except borders, no arbitrary hex — token utilities only). Structure and copy come from `apps/web/design/exports/saved-card-row.html`, translated per that export's own caveats (fixed `px` sizing and no `.html`/`.ts` split are the export's, not this component's). The three states from the spec's Web section:
  ```html
  <!-- saved-card-row.html — sketch; verify exact utility spelling against styles.css -->
  <div
    data-testid="saved-card-row"
    class="flex items-center gap-3 rounded-md border p-4"
    [class.bg-surface-subtle]="selected() || expired()"
    [class.border-brand-navy]="selected() && !expired()"
    [class.border-line]="!selected() || expired()"
  >
    <span data-testid="radio" [attr.aria-disabled]="expired()" (click)="!expired() && select.emit(card().id)"></span>
    <div
      data-testid="brand-bubble"
      class="flex h-10 w-10 items-center justify-center rounded-full"
      [class.bg-brand-navy-light]="!expired()"
      [class.bg-surface-subtle]="expired()"
    >
      <lucide-icon name="credit-card" [class.text-brand-navy]="!expired()" [class.text-ink-muted]="expired()" />
    </div>
    <div class="flex flex-1 flex-col">
      <div class="flex items-center gap-2">
        <span class="text-ink-primary">{{ card().brand }} ···· {{ card().last4 }}</span>
        @if (isDefault()) {
          <span class="rounded-full bg-brand-navy px-2 py-0.5 text-white">Default</span>
        }
      </div>
      <span
        data-testid="card-expiry"
        [class.text-danger-red]="expired()"
        [class.font-semibold]="expired()"
        [class.text-ink-secondary]="!expired()"
      >
        {{ expired() ? 'Expired' : 'Expires' }} {{ card().expMonth }} / {{ card().expYear }}
      </span>
    </div>
    <div class="flex flex-col items-end gap-1">
      @if (!isDefault()) {
        <button data-testid="set-default-link" type="button" class="text-brand-navy" (click)="setDefault.emit(card().id)">
          Set as default
        </button>
      }
      <button type="button" (click)="remove.emit(card().id)">
        <lucide-icon name="x" class="text-ink-secondary" />
      </button>
    </div>
  </div>
  ```
  Run `nvm use && pnpm --filter web test saved-card-row` — passes.

- [ ] 11.3 Add `NG_APP_STRIPE_PUBLISHABLE_KEY` to `apps/web/src/env.d.ts`:
  ```ts
  interface ImportMetaEnv {
    readonly NG_APP_STRIPE_ENABLED?: string;
    readonly NG_APP_STRIPE_PUBLISHABLE_KEY?: string;
    readonly NG_APP_API_GATEWAY_URL?: string;
    readonly NG_APP_GEOCODE_ENABLED?: string;
    readonly NG_APP_WS_URL?: string;
  }
  ```

- [ ] 11.4 Extend `AppConfig` and its reader in `app-config.ts`. Per [[env-files]]/the repo's esbuild rule, spell out the full `import.meta.env.NG_APP_STRIPE_PUBLISHABLE_KEY` access — do not construct the key name dynamically:
  ```ts
  export interface AppConfig {
    readonly stripeEnabled: boolean;
    /** The ONLY Stripe value allowed in the bundle — never a restricted key. Null disables card entry even if stripeEnabled is true, degrading gracefully. */
    readonly stripePublishableKey: string | null;
    readonly apiGatewayUrl: string;
    readonly geocodeEnabled: boolean;
    readonly wsUrl: string;
  }
  ```
  and in the function that builds `APP_CONFIG` from `import.meta.env` (locate the existing `stripeEnabled` line and add immediately after it):
  ```ts
  stripePublishableKey: import.meta.env.NG_APP_STRIPE_PUBLISHABLE_KEY ?? null,
  ```
  Treat an empty string the same as unset (`?? null` alone does not catch `""`) — mirror the
  Users rule that a seeded-empty Stripe value means unset, per [[env-files]].

- [ ] 11.4b **No `NG_APP_*` web build arg is hardcoded in `docker-compose.yml`.**
  **Decision (user, 2026-09-22):** every `NG_APP_*` the web Dockerfile declares as an `ARG` is
  passed by compose interpolation from the generated root `.env`
  (`NG_APP_X: "${NG_APP_X}"`), and `make env-file` generates/seeds every one of them:
  - **AUTO box** (generator-owned, derived — never hand-edited): `NG_APP_API_GATEWAY_URL`
    (`/v1`) and the WS URL (`NG_APP_WS_URL: "${WS_URL:-}"` — keep the existing `WS_URL`
    interpolation name; do not rename it without updating every reference).
  - **CUSTOM box**, seeded per key with the existing `custom_defaults` mechanism (per-machine
    choices, preserved across regeneration): `NG_APP_STRIPE_ENABLED=false`,
    `NG_APP_STRIPE_PUBLISHABLE_KEY=` (empty — the `pk_test_...` key is public by design but
    still per-developer/sandbox), `NG_APP_GEOCODE_ENABLED` (seed with today's compose default,
    `true`), and `NG_APP_RUM_ENABLED` (check how it is passed today and seed the same way).
  - Update `infra/environments/local/scripts/generate_env_files.py`'s root-`.env` block (today
    documented as "ONLY what compose interpolates", four AUTO vars — see [[env-files]]) to add
    the CUSTOM box above, and update `docker-compose.yml`'s `web.build.args` to interpolate
    every one of these from `.env` instead of the literals currently there
    (`NG_APP_STRIPE_ENABLED: "false"`, `NG_APP_GEOCODE_ENABLED: "true"`).
  - **These are BUILD-time values**: changing one still needs `docker compose build web` — a
    plain restart re-serves the old bundle.
  - This step is where `NG_APP_STRIPE_PUBLISHABLE_KEY` moves from a hand-edited
    `apps/web/.env` (as [[stripe-sandbox-setup]] describes until this task lands) to the root
    `.env` CUSTOM box seeded by `make env-file`. Cross-reference Task 14 step 14.6 (Users'
    seeded, empty-means-unset Stripe keys) — the two mechanisms must stay consistent.

- [ ] 11.5 Write the failing spec for `payment-method-selector.ts` asserting: it lists saved cards from `PaymentMethodsApi.list()`, preselects the default, exposes a `selectedPaymentMethodId` output, and shows the Payment Element (mounted against a SetupIntent client_secret from `PaymentMethodsApi.createSetupIntent()`) when the user has zero cards or clicks "Add card".

- [ ] 11.6 Create `apps/web/src/app/core/api/payment-methods-api.ts` following the existing `UsersApi`/`OrdersApi` shape (HTTP client wrapper, one method per route from Task 4):
  ```ts
  @Injectable({ providedIn: 'root' })
  export class PaymentMethodsApi {
    private readonly http = inject(HttpClient);

    createSetupIntent(): Observable<{ clientSecret: string }> {
      return this.http.post<{ clientSecret: string }>('/v1/users/me/payment-methods/setup-intent', {});
    }

    list(): Observable<PaymentMethodView[]> {
      return this.http.get<PaymentMethodView[]>('/v1/users/me/payment-methods');
    }

    attach(paymentMethodId: string): Observable<{ id: string }> {
      return this.http.post<{ id: string }>('/v1/users/me/payment-methods', { paymentMethodId });
    }

    remove(id: string): Observable<void> {
      return this.http.delete<void>(`/v1/users/me/payment-methods/${id}`);
    }

    setDefault(id: string): Observable<void> {
      return this.http.put<void>(`/v1/users/me/payment-methods/${id}/default`, {});
    }
  }
  ```

- [ ] 11.7 Implement `payment-method-selector.ts`/`.html` following [[angular-component-authoring]] (signals, `OnPush`, no domain logic beyond presentation), loading Stripe.js via `loadStripe(APP_CONFIG.stripePublishableKey)`, mounting the Payment Element into a container div when adding a card, and never using the Card Element.

- [ ] 11.8 Replace the static card at `checkout-payment.html:259` (`@if (stripeEnabled())` branch) with `<app-payment-method-selector (selectedPaymentMethodId)="onCardSelected($event)" />`.

- [ ] 11.9 In `checkout-payment.ts`, add a `selectedPaymentMethodId` signal, wire `onCardSelected`, extend `canPay` to also require it when `stripeEnabled()` is true:
  ```ts
  protected readonly selectedPaymentMethodId = signal<string | null>(null);

  protected readonly canPay = computed(
    () =>
      this.cart.canCheckout() &&
      !this.cart.saving() &&
      !this.placing() &&
      this.address() !== null &&
      (!this.stripeEnabled() || this.selectedPaymentMethodId() !== null),
  );

  protected onCardSelected(id: string): void {
    this.selectedPaymentMethodId.set(id);
  }
  ```

- [ ] 11.10 Update `pay()` to send `paymentMethodId` and map 402 through `authErrorMessage`, mirroring the existing 409 entry:
  ```ts
  const order = await firstValueFrom(
    this.ordersApi.createOrder(lines, this.stripeEnabled() ? this.selectedPaymentMethodId() : null),
  );
  // ...
  this.checkoutError.set(
    authErrorMessage(error, {
      409: 'Someone bought the last one while you were checking out. Adjust your cart and try again.',
      402: authErrorMessage(error), // Stripe's own actionable message passes through ApiError.detail
    }),
  );
  ```
  (`OrdersApi.createOrder` gains an optional `paymentMethodId` parameter forwarded into the POST body — modify its signature accordingly and update every existing call site.)

- [ ] 11.10b **Generate and send the `Idempotency-Key` header (spec Decision 7, user decision
  2026-09-22).** Per the client contract: generate ONE key (`crypto.randomUUID()`) per checkout
  attempt when `pay()` is first invoked; reuse that same key only when retrying after a network
  error, a timeout, or a 5xx from the same attempt; generate a fresh key after any definitive
  response (any 2xx or 4xx), including a 402 decline — a declined card is a definitive response
  the buyer will correct and resubmit, not a transient failure to retry blindly. Store the
  current key in a signal alongside `selectedPaymentMethodId`, reset it to a new UUID whenever
  `pay()` completes with a 2xx/4xx. `OrdersApi.createOrder` sends it as the `Idempotency-Key`
  request header (not a body field) on every `POST /v1/orders` call, through `ApiClient` per
  [[browser-rum]] (a raw `fetch()` would bypass the interceptor and the header both). Write a
  spec asserting: the header is present and unchanged across a simulated retry after a network
  error, and a **new** header value appears on the next `pay()` call after a successful order or
  a 402. Run `nvm use && pnpm --filter web test checkout-payment` — passes.

- [ ] 11.11 Confirm `devFill()` remains unchanged and does not touch `selectedPaymentMethodId` or the Stripe branch — it stays scoped to `addressModel`/`cardModel` exactly as today (the plain branch), per Decision "Constraints" in the Web section.

- [ ] 11.12 Run `nvm use && pnpm --filter web test` — confirm the new and updated specs pass.

- [ ] 11.13 Modify `OrdersApi.createOrder` (or add a sibling parameter) so that on the plain branch it also sends the detected `card: { brand, last4, expMonth, expYear }` metadata alongside the order body — never the PAN, never the CVC (Decision 21; Task 13 supplies the detector this reads from). On the Stripe branch this field is omitted entirely; Orders' Task 9.9 validation only runs when `STRIPE_ENABLED=false`.

- [ ] 11.14 Write the failing spec for `new-card-block.ts` (Decision 23) asserting: it renders `Method Tabs` (Card / Apple Pay / Link) and the four `SField` rows, a "Cancel" link emits a `cancel` output collapsing it back to the saved-cards list, the "Save this card for future purchases" checkbox defaults unchecked, and confirming the SetupIntent calls `PaymentMethodsApi.attach(...)` when checked vs. leaving the resulting payment method unattached (no `attach` call) when unchecked:
  ```ts
  it('attaches the payment method only when "save this card" is checked', async () => {
    const api = { attach: vi.fn().mockReturnValue(of({ id: 'pm_new' })) };
    // ... mount NewCardBlock with a fake confirmed Stripe.js setup result (pm_new) ...
    component['saveForFuture'].set(false);
    await component.confirm();
    expect(api.attach).not.toHaveBeenCalled();

    component['saveForFuture'].set(true);
    await component.confirm();
    expect(api.attach).toHaveBeenCalledWith('pm_new');
  });
  ```
  Run `nvm use && pnpm --filter web test new-card-block` — fails, module missing.

- [ ] 11.15 Implement `new-card-block.ts`/`.html` per [[angular-component-authoring]], structure and copy from the `New Card Block` portion of `apps/web/design/exports/checkout-payment-add-card.html`. The `Save Info Row` checkbox drives Decision 23's branch — on confirm, the Payment Element/Stripe.js confirms the SetupIntent (mounted from `PaymentMethodsApi.createSetupIntent()`, unchanged from step 11.7's flow), and only when `saveForFuture()` is `true` does the component call `PaymentMethodsApi.attach(paymentMethodId)`; when `false`, the resulting `pm_...` is passed straight to `pay()` for one-time use on this order's `POST /v1/orders` and never attached. Run `nvm use && pnpm --filter web test new-card-block` — passes.

- [ ] 11.16 Wire `payment-method-selector.ts` to show `new-card-block` in place of the bare Payment Element mount from step 11.7, and to show the saved-cards list (composed of `SavedCardRow` instances per 11.1–11.2) when the user has ≥1 card, collapsing to/from `new-card-block` on "Add card" / "Cancel". Update `payment-method-selector`'s spec to cover both transitions. Run `nvm use && pnpm --filter web test payment-method-selector` — passes.

- [ ] 11.17 **Confirm the new calls inherit [[browser-rum]]'s rules — it does not get its own
  (spec Decision 25).** `PaymentMethodsApi` (step 11.6) and `OrdersApi.createOrder`'s new
  `paymentMethodId` parameter (step 11.10) MUST go through Angular's `HttpClient`/`ApiClient`
  path — grep for any raw `fetch()` in the new files this task created
  (`grep -rn "fetch(" apps/web/src/app/core/api/payment-methods-api.ts
  apps/web/src/app/features/checkout/`) and confirm there are none; a raw `fetch()` bypasses
  `rumPropagationInterceptor` entirely, producing no CLIENT span and no `traceparent`. Confirm a
  card error thrown by `payment-method-selector.ts`/`new-card-block.ts` (a rejected SetupIntent
  confirmation, an `ApiError` from `attach()`) is **not** swallowed silently — either rethrown
  so it reaches `RumErrorHandler`, or reported deliberately — and that no full Stripe error
  object is ever passed to the error handler wholesale (only `message`/`type`/`status`/`detail`
  per [[browser-rum]]'s allow-list). Add or extend a spec asserting a simulated Stripe
  confirmation failure still surfaces to the error handler rather than being caught-and-dropped
  inside the component. Run `nvm use && pnpm --filter web test` — passes.

- [ ] 11.18 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 12 — Web: Profile — Payment methods tab (Decision 22)

This task reuses `SavedCardRow` and `PaymentMethodsApi` from Task 11 — it must be ordered
after Task 11, not worked in parallel with it (Execution notes).

**Files:**
- Modify: `apps/web/src/app/features/account/profile.ts`, `apps/web/src/app/features/account/profile.html`
- Create: `apps/web/src/app/features/account/payment-methods-tab.ts` (+ `.html`), `apps/web/src/app/features/account/profile-add-card.ts` (+ `.html`), `apps/web/src/app/features/account/profile-add-card.spec.ts`, `apps/web/src/app/features/account/payment-methods-tab.spec.ts`
- Test: `payment-methods-tab.spec.ts`, `profile-add-card.spec.ts`, an updated spec for `profile.ts` asserting the tab is absent when `STRIPE_ENABLED` is off

**Interfaces:**
- Consumes: `SavedCardRow` (Task 11.1–11.2), `PaymentMethodsApi` (Task 11.4).
- Produces: no new HTTP surface (spec Decision 22) — this task is a second UI consumer of Task 4's existing five routes.

### Steps

- [ ] 12.1 Write the failing spec for `payment-methods-tab.ts`, asserting: it renders a `Tabs` frame with "Delivery address" and "Payment methods", the active tab carries `text-ink-primary`/`font-semibold` and a visible `Tab Indicator`, the inactive tab carries `text-ink-secondary` and a fully transparent indicator (the `.pen` stores the inactive indicator as transparent; use the same token utility `saved-card-row` uses for its unselected state rather than re-deriving one), and switching tabs toggles which section renders below:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { TestBed } from '@angular/core/testing';
  import { PaymentMethodsTab } from './payment-methods-tab';

  describe('PaymentMethodsTab', () => {
    it('defaults to the delivery-address tab active, payment-methods inactive', () => {
      const fixture = TestBed.createComponent(PaymentMethodsTab);
      fixture.detectChanges();
      const active = fixture.nativeElement.querySelector('[data-testid="tab-delivery-address"]');
      const inactive = fixture.nativeElement.querySelector('[data-testid="tab-payment-methods"]');
      expect(active.className).toContain('text-ink-primary');
      expect(active.className).toContain('font-semibold');
      expect(inactive.className).toContain('text-ink-secondary');
    });

    it('switches to the SAVED CARDS section when the payment-methods tab is clicked', () => {
      const fixture = TestBed.createComponent(PaymentMethodsTab);
      fixture.detectChanges();
      fixture.nativeElement.querySelector('[data-testid="tab-payment-methods"]').click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="saved-cards-section"]')).not.toBeNull();
    });
  });
  ```
  Run `nvm use && pnpm --filter web test payment-methods-tab` — fails, module missing.

- [ ] 12.2 Implement `payment-methods-tab.ts`/`.html` per [[angular-component-authoring]], structure and copy from `apps/web/design/exports/profile-payment-methods.html`. The `SAVED CARDS` section renders a `Section Top` (label + live count, e.g. `` `${cards().length} cards` ``), the `Cards List` composed of `SavedCardRow` instances (reusing Task 11's component — do not reimplement its markup here), an `Add Card Button` that is a direct usage of the existing `Button Ghost` component (`apps/web/src/app/shared/ui/button-ghost.ts`, per `DESIGN.md`'s component table — not a new button), and a `Security Note` ("Cards are stored by Stripe. 3MRAI never sees your full card number.", `text-ink-muted`). Wire `Cards List`'s row events (`select`, `setDefault`, `remove`) to `PaymentMethodsApi.setDefault()`/`remove()`, refetching the list after each. Run `nvm use && pnpm --filter web test payment-methods-tab` — passes.

- [ ] 12.3 Write the failing spec for `profile-add-card.ts` (the `wnUi1` frame, mobile `WQAq0`), asserting it mounts the Payment Element against `PaymentMethodsApi.createSetupIntent()`'s client_secret exactly as Task 11's `payment-method-selector` does, and on successful confirmation calls `PaymentMethodsApi.attach(...)` then navigates back to the Payment methods tab with the new card visible. Reuse the mounting logic from Task 11.5 rather than reimplementing Stripe.js setup — extract a small shared helper if duplication would otherwise exceed a few lines.

- [ ] 12.4 Implement `profile-add-card.ts`/`.html` per [[angular-component-authoring]], structure and copy from `apps/web/design/exports/profile-add-card.html`. Run `nvm use && pnpm --filter web test profile-add-card` — passes.

- [ ] 12.5 Wire `payment-methods-tab.ts`'s `Add Card Button` to navigate to (or inline-mount, matching whichever pattern `checkout-payment`'s "Add card" already uses — copy that transition, don't invent a second one) `profile-add-card.ts`.

- [ ] 12.6 In `profile.ts`/`profile.html`, mount `payment-methods-tab` only when `APP_CONFIG.stripeEnabled` is `true` (spec Decision 22 — with the flag off, the profile keeps its pre-milestone single-view shape: no `Tabs` frame, no `SAVED CARDS` section). Write the failing spec first asserting `payment-methods-tab` is absent from the DOM when `stripeEnabled` is `false`, then wire the `@if`.

- [ ] 12.7 Run `nvm use && pnpm --filter web test` — confirm the new and updated specs pass, and that no arbitrary hex colour class was introduced (`grep -rnE '(bg|text|border)-\[#' apps/web/src/app/features/account/` — expect no matches, per `apps/web/CLAUDE.md`'s §2a golden rule).

- [ ] 12.8 **Same [[browser-rum]] inheritance check as step 11.17, for the profile surface (spec
  Decision 25).** `payment-methods-tab.ts` and `profile-add-card.ts` reuse `PaymentMethodsApi`
  (Task 11.6) rather than a new client, so this is confirmation, not new wiring: grep the two
  new files for a raw `fetch()` (expect none), and confirm a card error from
  `profile-add-card.ts`'s SetupIntent confirmation reaches `RumErrorHandler` the same way Task
  11.17 requires for checkout, rather than being caught and only shown as UI text. Run
  `nvm use && pnpm --filter web test` — passes.

- [ ] 12.9 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 13 — Card-field validation on the plain branch (Decision 21)

**Files:**
- Create: `apps/web/src/app/shared/ui/card-validation.ts`, `apps/web/src/app/shared/ui/card-validation.spec.ts`
- Modify: `apps/web/src/app/shared/ui/numeric-input.ts`, `apps/web/src/app/shared/ui/numeric-input.spec.ts` (create if absent), `apps/web/src/app/features/checkout/checkout-payment.ts`, `apps/web/src/app/features/checkout/checkout-payment.html`

**Interfaces:**
- Consumes: nothing from other tasks — pure functions with no Angular/HTTP dependency.
- Produces:
  ```ts
  export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'diners' | 'jcb' | 'unknown';

  export function detectCardBrand(digits: string): CardBrand;
  export function isValidCardNumber(digits: string): boolean; // length-per-brand AND Luhn
  export function requiredCvcLength(brand: CardBrand): 3 | 4;
  export function isValidCvc(digits: string, brand: CardBrand): boolean;
  export function isValidExpiry(month: number, year: number, today: Date): boolean;
  export function groupCardDigits(value: string): string; // brand-aware, replaces numeric-input.ts's current one
  ```
  Consumed by Task 11's `checkout-payment.ts` (`canPay`, `cardForm` validators) — this task must land independently of, and be reviewable independently from, Task 11's Payment Element work, even though both touch `checkout-payment.html`.

This task does NOT depend on Tasks 9–10 being merged (it touches only the plain branch and pure functions), so it may be implemented in parallel with Task 11, but both still wait behind the second GATE before merging, since both modify `checkout-payment.html`/`.ts` and should be reviewed as a coherent batch.

### Steps

- [ ] 13.1 Write the failing spec for Luhn and brand detection, `card-validation.spec.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { detectCardBrand, isValidCardNumber } from './card-validation';

  describe('isValidCardNumber (Luhn + length)', () => {
    it('accepts a valid Visa number', () => {
      expect(isValidCardNumber('4242424242424242')).toBe(true);
    });

    it('rejects a transposed-digit number of the correct length', () => {
      expect(isValidCardNumber('4242424242424241')).toBe(false);
    });
  });

  describe('detectCardBrand', () => {
    it.each([
      ['4242424242424242', 'visa'],
      ['5454545454545454', 'mastercard'],
      ['2221000000000009', 'mastercard'],
      ['378282246310005', 'amex'],
      ['6011111111111117', 'discover'],
      ['9999999999999999', 'unknown'],
    ] as const)('detects %s as %s', (number, brand) => {
      expect(detectCardBrand(number)).toBe(brand);
    });
  });
  ```
  Run `nvm use && pnpm --filter web test card-validation` — fails, module missing.

- [ ] 13.2 Implement brand detection and Luhn in `card-validation.ts`:
  ```ts
  export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'diners' | 'jcb' | 'unknown';

  // Unrecognised prefixes fall back to 'unknown' rather than being rejected —
  // a valid card from an unlisted issuer must still be accepted (spec D21).
  export function detectCardBrand(digits: string): CardBrand {
    if (/^4/.test(digits)) return 'visa';
    if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return 'mastercard';
    if (/^3[47]/.test(digits)) return 'amex';
    if (/^(6011|65|64[4-9])/.test(digits)) return 'discover';
    if (/^(30[0-5]|3095|36|38|39)/.test(digits)) return 'diners';
    if (/^35(2[89]|[3-8]\d)/.test(digits)) return 'jcb';
    return 'unknown';
  }

  const LENGTHS_BY_BRAND: Record<CardBrand, number[]> = {
    visa: [13, 16, 19],
    mastercard: [16],
    amex: [15],
    discover: [16, 19],
    diners: [14, 16, 19],
    jcb: [16, 17, 18, 19],
    unknown: [12, 13, 14, 15, 16, 17, 18, 19],
  };

  // Catches a transposed digit that length alone cannot — e.g. `4242 4242
  // 4242 4241` has Visa's 16 digits and is invalid.
  function passesLuhn(digits: string): boolean {
    let sum = 0;
    let shouldDouble = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let digit = Number(digits[i]);
      if (shouldDouble) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
    }
    return sum % 10 === 0;
  }

  export function isValidCardNumber(digits: string): boolean {
    const brand = detectCardBrand(digits);
    return LENGTHS_BY_BRAND[brand].includes(digits.length) && passesLuhn(digits);
  }
  ```
  Run `nvm use && pnpm --filter web test card-validation` — passes.

- [ ] 13.3 Write the failing spec for length-per-brand edge cases:
  ```ts
  describe('isValidCardNumber (length per brand)', () => {
    it('rejects a 15-digit Visa', () => {
      // 15 valid Luhn digits starting with 4, not a real length for Visa
      expect(isValidCardNumber('424242424242423')).toBe(false);
    });

    it('accepts a 15-digit Amex', () => {
      expect(isValidCardNumber('378282246310005')).toBe(true);
    });

    it('rejects a 16-digit Amex', () => {
      expect(isValidCardNumber('3782822463100050')).toBe(false);
    });
  });
  ```
  Run `nvm use && pnpm --filter web test card-validation` — passes against the 15.2 implementation (no code change needed if 15.2 was implemented correctly; if it fails, fix `LENGTHS_BY_BRAND` before proceeding).

- [ ] 13.4 Write the failing spec for CVC:
  ```ts
  import { isValidCvc, requiredCvcLength } from './card-validation';

  describe('CVC length per brand', () => {
    it('requires 3 digits for Visa', () => {
      expect(requiredCvcLength('visa')).toBe(3);
      expect(isValidCvc('123', 'visa')).toBe(true);
      expect(isValidCvc('1234', 'visa')).toBe(false);
    });

    it('requires 4 digits for Amex', () => {
      expect(requiredCvcLength('amex')).toBe(4);
      expect(isValidCvc('1234', 'amex')).toBe(true);
      expect(isValidCvc('123', 'amex')).toBe(false);
    });
  });
  ```
  Implement:
  ```ts
  export function requiredCvcLength(brand: CardBrand): 3 | 4 {
    return brand === 'amex' ? 4 : 3;
  }

  export function isValidCvc(digits: string, brand: CardBrand): boolean {
    return digits.length === requiredCvcLength(brand) && /^\d+$/.test(digits);
  }
  ```
  Run `nvm use && pnpm --filter web test card-validation` — passes.

- [ ] 13.5 Write the failing spec for expiry, using an injected clock rather than a hardcoded year:
  ```ts
  import { isValidExpiry } from './card-validation';

  describe('isValidExpiry', () => {
    const today = new Date(2026, 8, 15); // 2026-09-15 — Date months are 0-indexed

    it('rejects an invalid month', () => {
      expect(isValidExpiry(13, 2030, today)).toBe(false);
    });

    it('rejects a month one month in the past', () => {
      expect(isValidExpiry(8, 2026, today)).toBe(false); // August 2026 already ended
    });

    it('accepts the current month (end-of-month rule)', () => {
      expect(isValidExpiry(9, 2026, today)).toBe(true); // September 2026 has not ended yet
    });

    it('accepts a future date', () => {
      expect(isValidExpiry(1, 2030, today)).toBe(true);
    });
  });
  ```
  Implement:
  ```ts
  // Compares against the LAST day of the expiry month, not the first — a card
  // expiring in the current month is still valid (spec D21).
  export function isValidExpiry(month: number, year: number, today: Date): boolean {
    if (month < 1 || month > 12) return false;
    const fullYear = year < 100 ? 2000 + year : year;
    const lastDayOfExpiryMonth = new Date(fullYear, month, 0); // day 0 of next month = last day of this month
    lastDayOfExpiryMonth.setHours(23, 59, 59, 999);
    return lastDayOfExpiryMonth >= today;
  }
  ```
  Run `nvm use && pnpm --filter web test card-validation` — passes.

- [ ] 13.6 Write the failing spec for brand-aware grouping in `numeric-input.spec.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { groupCardDigits } from './numeric-input';

  describe('groupCardDigits', () => {
    it('groups a Visa number in 4s', () => {
      expect(groupCardDigits('4242424242424242')).toBe('4242 4242 4242 4242');
    });

    it('groups an Amex number 4-6-5', () => {
      expect(groupCardDigits('378282246310005')).toBe('3782 822463 10005');
    });
  });
  ```
  Run `nvm use && pnpm --filter web test numeric-input` — fails against the current 4-4-4-4-only grouping.

- [ ] 13.7 Implement brand-aware grouping, replacing `numeric-input.ts`'s `groupCardDigits` and rewriting its comment to describe the final state (per the repo's code-comment rules — no "used to do X" narration):
  ```ts
  import { detectCardBrand } from './card-validation';

  export function digitsOnly(value: string, maxLength?: number): string {
    const digits = value.replace(/\D/g, '');
    return maxLength === undefined ? digits : digits.slice(0, maxLength);
  }

  // CONTRACT: The single definition of the card number's on-screen shape,
  // brand-aware. Amex groups 4-6-5; every other detected brand groups 4-4-4-4.
  // Typing and dev autofill both route through it, so a filled field is
  // indistinguishable from a typed one.
  export function groupCardDigits(value: string): string {
    const digits = digitsOnly(value, 19);
    const brand = detectCardBrand(digits);
    const pattern = brand === 'amex' ? [4, 6, 5] : [4, 4, 4, 4, 3];
    const groups: string[] = [];
    let index = 0;
    for (const size of pattern) {
      if (index >= digits.length) break;
      groups.push(digits.slice(index, index + size));
      index += size;
    }
    return groups.join(' ');
  }
  ```
  Run `nvm use && pnpm --filter web test numeric-input` — passes.

- [ ] 13.8 Write the failing component-level spec for `canPay` in `checkout-payment.spec.ts` (extend the existing spec file), asserting `canPay()` is `false` on the plain branch with an invalid card and `true` once the card form is valid, with a valid address on file:
  ```ts
  it('disables Pay on the plain branch when the card is invalid', () => {
    // ... existing harness setup with stripeEnabled=false and a saved address ...
    component['cardModel'].set({
      cardNumber: '4242 4242 4242 4241', // fails Luhn
      cardHolder: 'Jane Doe',
      cardExpiry: '12 / 30',
      cardCvc: '123',
    });
    expect(component['canPay']()).toBe(false);
  });

  it('enables Pay on the plain branch when the card is valid', () => {
    component['cardModel'].set({
      cardNumber: '4242 4242 4242 4242',
      cardHolder: 'Jane Doe',
      cardExpiry: '12 / 30',
      cardCvc: '123',
    });
    expect(component['canPay']()).toBe(true);
  });
  ```
  Run `nvm use && pnpm --filter web test checkout-payment` — fails, `cardForm` has no validators yet.

- [ ] 13.9 Add real validators to `cardForm` in `checkout-payment.ts`, mirroring `addressForm`'s pattern:
  ```ts
  import {
    detectCardBrand,
    isValidCardNumber,
    isValidCvc,
    isValidExpiry,
  } from '../../shared/ui/card-validation';

  protected readonly cardForm = form(this.cardModel, (path) => {
    required(path.cardHolder, { message: 'Enter the name on the card' });
    pattern(path.cardHolder, /\S/, { message: 'Enter the name on the card' });
    validate(path.cardNumber, ({ value }) => {
      const digits = digitsOnly(value());
      return isValidCardNumber(digits) ? null : { kind: 'cardNumber', message: 'Enter a valid card number' };
    });
    validate(path.cardExpiry, ({ value }) => {
      const [month, year] = value().split('/').map((part) => Number(part.trim()));
      return isValidExpiry(month, year, new Date())
        ? null
        : { kind: 'cardExpiry', message: 'Enter a valid expiry date' };
    });
    validate(path.cardCvc, ({ value }) => {
      const brand = detectCardBrand(digitsOnly(this.cardModel().cardNumber));
      return isValidCvc(value(), brand) ? null : { kind: 'cardCvc', message: 'Enter a valid security code' };
    });
  });
  ```
  Note: `validate` must be imported from `@angular/forms/signals` alongside the existing `required`/`maxLength`/`pattern` imports; confirm its exact signature against how this Angular version's signal-forms API expresses a custom validator (check another existing custom validator in this codebase first via `grep -rln "validate(" apps/web/src` — copy that call shape exactly if it differs from the one shown here, since signal-forms is a newer API whose exact custom-validator signature must match what's already used elsewhere in this codebase rather than being guessed here).

- [ ] 13.10 Extend `canPay` in `checkout-payment.ts` to require `cardForm().valid()` only on the plain branch:
  ```ts
  protected readonly canPay = computed(
    () =>
      this.cart.canCheckout() &&
      !this.cart.saving() &&
      !this.placing() &&
      this.address() !== null &&
      (this.stripeEnabled()
        ? this.selectedPaymentMethodId() !== null
        : this.cardForm().valid()),
  );
  ```
  Run `nvm use && pnpm --filter web test checkout-payment` — passes.

- [ ] 13.11 Add error messages to `checkout-payment.html`'s plain-branch card fields, using the same `app-field`/error-rendering pattern the address form already uses above it (copy that exact markup shape rather than inventing a new one).

- [ ] 13.12 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 14 — Infra, compose and CSP

**Files:**
- Modify: `infra/modules/api-gateway/main.tf`, `infra/modules/compute/nginx/nginx.conf`, `apps/web`'s nginx config (locate via `find apps/web -iname "nginx*.conf"`), `docker-compose.yml`, `Makefile`, `.env.example`, `infra/environments/local/scripts/generate_env_files.py`

### Steps

- [ ] 14.1 Add the new Users routes (`/v1/users/me/payment-methods*`, `/v1/users/stripe/webhook`) to `infra/modules/api-gateway/main.tf`'s route map, following the existing route-block pattern for other `/v1/users/*` routes.

- [ ] 14.2 Add a `location` block for `/v1/users/stripe/webhook` (and the payment-methods paths, if they need a distinct block from the existing `/v1/users/` catch-all) in `infra/modules/compute/nginx/nginx.conf`. Per the spec's Infra section, a missing `location` block for a new top-level path silently falls through to `location /`, which routes to Users — verify the new paths already fall under an existing `/v1/users/` block rather than needing a new one, and only add a new block if they do not.

- [ ] 14.3 Add the CSP header change to `apps/web`'s nginx config, allowing `https://*.stripe.com` in `script-src`, `frame-src`, and `connect-src`:
  ```
  add_header Content-Security-Policy "... script-src 'self' https://*.stripe.com; frame-src 'self' https://*.stripe.com; connect-src 'self' https://*.stripe.com ...";
  ```
  (merge into the existing directive rather than replacing it — preserve every existing source already listed for each directive).

- [ ] 14.4 Add the `stripe-cli` service to `docker-compose.yml` behind `profiles: [stripe]`, following the `observability`/`preview` precedent:
  ```yaml
  stripe-cli:
    image: stripe/stripe-cli:latest
    profiles: [stripe]
    command: ["listen", "--forward-to", "users:3000/v1/users/stripe/webhook", "--api-key", "${STRIPE_SECRET_KEY}"]
    networks: [3mrai-network]
    env_file:
      - .env.local.users
  ```
  Note in a comment above it: `stripe listen` prints its own `whsec_...` signing secret on startup, different from the Dashboard's — using the Dashboard secret locally fails webhook signature verification with a 400 that looks like a code bug, not an infra one. That printed secret must be copied by hand into `STRIPE_WEBHOOK_SECRET` in the CUSTOM box of `.env.local.users`.

- [ ] 14.5 Add `make stripe-up` and `make stripe-logs` targets to the `Makefile`, mirroring the existing `observability-up`/`observability-*` targets' shape (`docker compose --profile stripe up -d` / `docker compose logs -f stripe-cli`).

- [ ] 14.6 Add every new variable to `.env.example` with a comment explaining AUTO vs CUSTOM per [[env-files]]: `STRIPE_ENABLED` (AUTO-generated default `false`), `STRIPE_SECRET_KEY` (CUSTOM, hand-injected `rk_...`), `STRIPE_WEBHOOK_SECRET` (CUSTOM, hand-injected `whsec_...` from `stripe listen`'s own output), `NG_APP_STRIPE_PUBLISHABLE_KEY` (CUSTOM, the publishable `pk_...` key, safe for the bundle).

  **Decision (user, 2026-09-22 — revised, supersedes the same-day decision below):**
  `infra/environments/local/scripts/generate_env_files.py` seeds three keys into the **CUSTOM**
  box of `.env.local.users` when they are absent — `STRIPE_ENABLED=false`,
  `STRIPE_SECRET_KEY=` (empty), `STRIPE_WEBHOOK_SECRET=` (empty) — using the existing per-key
  `custom_defaults` mechanism (same precedent as `CACHE_ENABLED`). Existing values are never
  overwritten, and a commented-out key is not re-seeded. The developer fills the two secrets
  and flips the flag in place, per [[env-files]]. `STRIPE_ENABLED` is **not** emitted in the
  AUTO box — one location only, no duplicate key between AUTO and CUSTOM.

  Users' env schema treats an empty or whitespace-only value for these three keys as unset:
  `STRIPE_ENABLED` defaults to `false`; an empty secret behaves as absent (flag on + no key →
  Stripe routes answer 503, per the design spec's Decision 13) instead of failing validation
  at boot.

  This is already implemented on `feat/stripe-payments-users` (generator + schema) — Task 14
  no longer needs to add it for Users. What remains here is **Orders**: when Orders gains its
  Stripe env vars (Task 9/14), its equivalent keys must follow the same rule — seeded empty in
  the CUSTOM box, empty treated as unset.

  Override precedence (verified 2026-09-22 with `docker compose config`) still holds as a fact
  about this repo's env-file layering — Compose keeps the **last** duplicate key in one
  `env_file`, `dotenv` keeps the **first** — but it matters less here now, since there is no
  AUTO/CUSTOM duplicate for `STRIPE_ENABLED` to order.

  <details>
  <summary>Superseded same-day decision (2026-09-22, kept for history)</summary>

  `infra/environments/local/scripts/generate_env_files.py`
  emits `STRIPE_ENABLED=false` in the AUTO-GENERATED box of `.env.local.users` (and
  `.env.local.orders`), so the default is visible in the generated file rather than only in
  `.env.example`. `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are **never** emitted by the
  generator — not even as empty placeholders — and live only in the CUSTOM box, hand-injected
  per [[env-files]].

  Why no empty placeholders: Users' env schema declares
  `STRIPE_SECRET_KEY: z.string().min(1).optional()` (Task 1.1), so an absent key is a valid
  boot state (Stripe routes answer 503, per Decision 13) while an empty `STRIPE_SECRET_KEY=`
  fails Zod's `.min(1)` validation and the service does not boot at all — a strictly worse
  failure mode than the one the flag is meant to degrade into.

  </details>

- [ ] 14.7 Run `nvm use && node scripts/validate-vault.mjs` is not applicable here (infra-only task); instead run this repo's existing Terraform validation/lint step for the touched modules if one exists (`grep -n "^validate\|^plan" Makefile`), and `docker compose config --profile stripe` to confirm the new compose service parses.

- [ ] 14.8 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 15 — The three test layers

**Files:**
- Create: `e2e/specs/internal/users/payment-methods.spec.ts`, `e2e/specs/internal/orders/order-payment.spec.ts`, `e2e/specs/gateway/checkout-payment.spec.ts`, `e2e/specs/gateway/profile-payment-methods.spec.ts`
- Modify: `e2e/support/global-teardown.ts` (if a new cleanup call is needed beyond the extended `e2e-cleanup` from Task 6), `e2e/load-tests/` scenario touching checkout (verify only, per step 15.8), `apps/web/src/app/shared/ui/saved-card-row.spec.ts` (extended per step 15.6, not duplicated)

### Steps

- [ ] 15.1 Write internal E2E specs against `localhost:3000` (Users) covering: create setup-intent, attach a card (using Stripe's test PaymentMethod token flow against the CI sandbox per Decision 17), list, set default, detach, and the webhook signature-rejection path (a request with a bad `stripe-signature` header gets 400). Tag every created row with `x-e2e-source: true` and confirm `E2E_TESTING_ENABLED` gates it, per [[testing]]'s "E2E cleanup by tag" mechanism.

- [ ] 15.2 Write internal E2E specs against `localhost:3001` (Orders) covering: `POST /v1/orders` with a valid `paymentMethodId` and `Idempotency-Key` succeeds and returns an order with a payment snapshot; with the flag on and `paymentMethodId` omitted, returns 400; with the flag on and the `Idempotency-Key` header omitted, returns 400 `idempotency_key_required` (step 9.10b); with a Stripe test card that triggers a decline (`4000000000000002`), returns 402; the metadata-only card validation from Task 9.9 (known/unknown brand, expired/valid, malformed `last4`); the same `(user, key)` POSTed twice returns the existing order on the second call and Stripe is charged exactly once (step 9.10b.2); and the concurrency scenario from Task 10.1 reproduced at the HTTP layer if feasible, or explicitly noted as covered only at the unit level with a comment pointing to Task 10.1's test name.

- [ ] 15.3 Write the gateway E2E spec with a real Cognito JWT covering the full Stripe-branch UI journey: log in, go to checkout, add a card via the mounted Payment Element (fill Stripe's test iframe using Playwright's frame-locator APIs against the CI sandbox), see it appear in the selector, switch to it, and pay. Assert on a genuine 401→success sequence if a route is initially unwired: per the spec's Infra section, a 404 carrying the gateway's own `{"message":"Not Found"}` body means the request never reached the service (fix the gateway/nginx wiring from Task 13), while a 401 after fixing it is the **correct** intermediate signal that the route resolved and reached the authorizer. Include at least the two idempotency cases named in the CLAUDE.md-driven scope for this milestone: (a) missing `Idempotency-Key` header with the flag on returns 400 through the real gateway; (b) replaying the same checkout request (same `Idempotency-Key`, e.g. by resubmitting after simulating a network drop) returns the same order rather than a second charge, verified by asserting only one order appears in the buyer's order history after both requests.

- [ ] 15.4 Write a second gateway E2E spec covering the **plain-branch** card validation from Task 13 (Decision 21): with `STRIPE_ENABLED=false`, typing an invalid card number (e.g. `4242 4242 4242 4241`) into the plain form leaves the Pay button disabled; correcting it to `4242 4242 4242 4242` with a valid future expiry and a 3-digit CVC enables Pay and a successful order follows. This is independent of Task 15.3's Stripe-branch journey — it exercises the branch the Payment Element never touches.

- [ ] 15.5 Write a gateway E2E spec for the **profile Payment methods flow** (Task 12): log in, open `/profile`, switch to the "Payment methods" tab, add a card via the mounted Payment Element (same frame-locator approach as 15.3), set it as default, remove a different saved card, and confirm the `SAVED CARDS` count updates after each action. Mobile variants (`W6IFps`, `WQAq0`) are the reference for the responsive layout if a mobile viewport pass is added later — this step covers desktop only.

- [ ] 15.6 Write a component-level spec (co-located with `saved-card-row.spec.ts` from Task 11.1, extended rather than duplicated) asserting the three `SavedCardRow` states render correctly end-to-end within `payment-method-selector` and the profile's Cards List, including that clicking the radio on an expired card does **not** emit `select` (Decision 24 — an expired card cannot be selected for payment).

- [ ] 15.7 Add an explicit test (any layer) asserting that with `STRIPE_ENABLED=false`, `POST /v1/orders` succeeds with no `paymentMethodId` and no payment-method routes are reachable (404 or route-not-mounted, per how Task 4.8 resolved conditional mounting) — proving the flag gate, not assuming it. Also assert that with the flag off, the profile's "Payment methods" tab (Task 12) does not render — the `Tabs` frame and `SAVED CARDS` section are absent, and the profile keeps its pre-milestone single-view shape (Decision 22).

- [ ] 15.8 Verify, by reading `e2e/load-tests/` (not by running the load suite against real Stripe), that no load-test scenario sends `x-e2e-source` or `x-test-mode` and that the checkout scenario either runs exclusively with `STRIPE_ENABLED=false` or is explicitly excluded from any Stripe-enabled load run — add a one-line comment in the relevant `.gatling.ts` scenario recording this if none exists yet. This is a verification step, not a new scenario — real charges under load would be expensive (spec Testing section).

- [ ] 15.9 Run all three layers: `nvm use && pnpm --filter e2e-impl test:internal` (or this repo's actual script name — check `e2e/package.json`), the gateway suite, and confirm green.

- [ ] 15.10 **Verify in the OpenObserve viewer, not by trusting a 200 (spec Decision 25;
  [[browser-rum]]; [[2026-08-21-verify-in-the-viewer-not-the-api]]).** Run the saved-card
  checkout journey from step 15.3 once against the local stack with the `stripe` compose
  profile up, then query OpenObserve directly (`observability/dashboards/README.md` /
  [[openobserve-runbook]] for how to reach it locally) for the resulting `trace_id`, allowing a
  full export cycle before concluding anything is missing — `BatchSpanProcessor` batches, and a
  short window produces a false FAIL as easily as a false PASS (same trap [[browser-rum]]
  documents for Trigger 3). Confirm, in that one trace:
  - a browser CLIENT span (`telemetry.source = rum`) for the checkout's `POST /v1/orders` call;
  - the gateway → Orders spans sharing the same `trace_id`;
  - a `stripe.payment_intent.create` CLIENT span under Orders, per step 9.10;
  - a `payment_charged` log line (Users' `stripe_customer_created`/`payment_method_attached`
    lines from earlier in the same session, if the card was added in this run, are a separate
    trace — they precede `POST /v1/orders` and are not expected inside this one trace).
  Separately, query for one declined-card attempt (Stripe test card `4000000000000002`) and
  confirm its span/log show `payment_declined` at INFO/WARN, never ERROR severity on the flow
  log — this is the concrete check behind Decision 25's "an ERROR here would put an ordinary
  decline on the on-call dashboard" rule, not merely a documented intention. This step is a
  manual/scripted verification, not a new automated test — record what was queried and seen (or
  not seen) in the task's report to the main session, the same way `2026-08-21-verify-in-the-viewer-not-the-api`
  documents its own verification runs.

- [ ] 15.11 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Execution notes

- Per [[phase-c-review-flow]], issues for Tasks 1–7 and Tasks 9–15 chain without per-merge prompts; PRs are batched for review at each of the two GATEs above, and nothing is auto-merged — the user reviews and merges each batch explicitly. Task 13 (plain-branch card validation) may be worked in parallel with the Task 9–10 wait, since it has no dependency on them, but its PR still joins the second batch. Task 12 (profile Payment methods tab) reuses `SavedCardRow` and `PaymentMethodsApi` from Task 11, so it must be ordered after Task 11 within the second batch, not worked in parallel with it.
- The Linear issues for this milestone do not exist yet. Once `linear-pm` creates them, a milestone-plan note is required at `docs/plans/stripe-payments-milestone.md` per [[milestone-plan]] (task-sequence table, dependency table, and dependency diagram) — this superpowers plan documents *how* to implement each task, not the milestone's cross-issue dependency structure, which is what that note is for.
- The user injects the restricted keys (`rk_...` for each service) and the webhook secret by hand into the CUSTOM box of `.env.local.users` and `.env.local.orders` — never the AUTO box. The dedicated local-dev and CI Stripe sandboxes (Decision 17) are a prerequisite of Task 1: without a sandbox and its keys, Task 1's `STRIPE_ENABLED=true` path cannot be exercised past the "no key" branch. See [[stripe-sandbox-setup]] for the step-by-step procedure to obtain both sandboxes and their keys.
- All design tokens this milestone's six new frames use (Decisions 22–24, Task 11's `SavedCardRow`, Task 12's profile tab) already exist in `apps/web/src/styles.css` — no task in this plan adds a token or touches `styles.css`.

## Self-review

**Spec coverage** — all 24 decisions map to at least one task:

| Decision | Task(s) |
|---|---|
| 1 (ownership split) | 3, 4, 9 |
| 2 (lazy customer creation) | 3, 4 |
| 3 (full metadata persisted) | 2, 4 |
| 4 (drift mitigation / webhook) | 5 |
| 5 (Orders payment snapshot) | 9 |
| 6 (gRPC stripe_customer_id) | 7, 9 |
| 7 (charge-then-persist; client-supplied Idempotency-Key) | 9 (step 9.10b), 11 (step 11.10b), 15 (steps 15.2–15.3) |
| 8 (402 on card errors) | 9 |
| 9 (refund on any post-charge failure, own idempotency key) | 10 (widened scope, step 10.2/10.2b) |
| 10 (Stripe CLI, not a tunnel) | 14 |
| 11 (E2E doesn't wait on webhook) | 15 (design already reflected in Task 4's attach flow) |
| 12 (E2E tagged in Stripe too) | 3, 4, 6, 15 |
| 13 (graceful degradation on missing key) | 1, 9 |
| 14 (stripe-mock excluded) | 15 (no task introduces it; Decision 17's sandbox is used instead) |
| 15 (restricted keys, one per service) | 1, 9, 14 |
| 16 (never payment_method_types; prohibited APIs) | Global Constraints, 4, 9, 11 |
| 17 (dedicated sandboxes) | 15, Execution notes |
| 18 (pinned versions, per-instance StripeClient) | Global Constraints, 1, 9 |
| 19 (PaymentIntents not Checkout Sessions) | 9 |
| 20 (Stripe Tax deferred; tax stays in-house) | 9 (amount = Orders' existing tax-inclusive total; no Stripe Tax call introduced anywhere) |
| 21 (plain-branch card validation, client + metadata-only server mirror) | 9 (server-side metadata mirror, step 9.9), 11 (frontend sends metadata, step 11.13), 13 (client validation), 15 (gateway E2E case, step 15.4) |
| 22 (payment methods managed from profile too) | 12 |
| 23 (checkout can add a card inline; save-card checkbox gates attach) | 11 (Task 11.14–11.16), 15 (gateway E2E, step 15.5) |
| 24 (expired saved card shown, not hidden) | 11 (`SavedCardRow`'s expired state, Task 11.1–11.2), 12 (profile Cards List reuses it), 15 (component spec, step 15.6) |
| 25 (Stripe calls join the logs/traces cascade) | 1 (`withStripeSpan` foundation, steps 1.7–1.8), 3 (step 3.3), 4 (step 4.10), 5 (step 5.5), 6 (step 6.3), 9 (step 9.10), 10 (step 10.4), 11 (step 11.17), 12 (step 12.8), 15 (step 15.10) |

**Placeholder scan:** no "TBD"/"similar to Task N" shortcuts remain except explicitly-flagged repo-verification steps (4.8's conditional-module choice, 4.7's decorator names, 9.1/10.1's exact mock/fixture APIs, 13.9's exact signal-forms `validate()` signature, 11.1's "verify exact utility spelling against styles.css") — each names the exact `grep` to run and the exact existing file to copy from, rather than leaving the shape undefined.

**Type consistency:** `StripeClientHolder` (Task 1) is the single shape threaded through Tasks 3, 4, 5, 6; `PaymentMethodView` (Task 4.3) is what Task 11's `PaymentMethodsApi.list()` consumes; `SavedCardView`/`SavedCardRow` (Task 11.1) is the single component both Task 11's checkout selector and Task 12's profile Cards List mount, never rebuilt per surface; `PaymentSnapshot` (Task 9) is what Task 10's refund path reads `PaymentIntentId` from; `stripe_customer_id` (Task 7) is the exact field both Task 9's gRPC read and Task 4/5's local persistence trace back to; `CardBrand`/`detectCardBrand`/`isValidCardNumber`/`isValidCvc`/`isValidExpiry` (Task 13) are the exact names Task 11's `checkout-payment.ts` imports and Task 13.7's `numeric-input.ts` rewrite depends on; the `{ brand, last4, expMonth, expYear }` metadata shape is identical between Task 11.13 (sender) and Task 9.9 (`CardMetadataValidator`, receiver); `withStripeSpan` (Task 1.8) is the single Node-side span helper Tasks 3, 4, 5, and 6 all wrap their Stripe calls in, and `StripeActivitySource` (Task 9.10) is its .NET-side sibling, consumed unchanged by Task 10's refund span; the client-generated `Idempotency-Key` header (Task 11.10b, sender) is the exact header Task 9.10b's Orders handler reads and persists as `IdempotencyKey`, and the Stripe idempotency key it derives (`order-charge-{userId}-{clientKey}`, Task 9.10b) is distinct in shape and purpose from the refund's own key (`refund-{paymentIntentId}`, Task 10.2) — the two are never confused or reused for each other.

## Related

- [[2026-09-19-stripe-payments-design]] — the design spec this plan implements task-by-task.
- [[testing]] — the three-layer gate every task's tests follow.
- [[env-files]] — the AUTO/CUSTOM box convention for every new Stripe env var.
- [[git-workflow]] — the commit/PR flow every task's final step defers to.
- [[phase-c-review-flow]] — the chained-issues/batched-review discipline around this plan's two GATEs.
- [[cqrs]] — the CommandBus/QueryBus dispatch discipline Task 4's tests follow.
- [[angular-component-authoring]] — the component pattern Task 11's `SavedCardRow`/`payment-method-selector`/`new-card-block` and Task 12's profile Payment methods tab follow.
- [[openapi-specs]] — where Task 4 and Task 5's new routes are specified.
- [[soft-delete]] — the deletion pattern `stripe_payment_methods` uses (Task 2, Task 4.5, Task 5.3).
- [[audit-fields]] — the standard audit columns on `stripe_payment_methods` (Task 2).
- [[nano-id]] — the primary-key convention for `stripe_payment_methods` (Task 2, Task 4.4).
- [[money-representation]] — the amount/currency representation Orders' payment snapshot follows (Task 9).
- [[local-dev]] — the `profiles:`-gated optional-service pattern `stripe-cli` follows (Task 14).
- [[skills-catalog]] — the Agent Skills installation mechanism already used for `stripe-best-practices`/`stripe-docs`.
- [[stripe-sandbox-setup]] — the operator-facing procedure for the sandboxes and keys the Execution notes call a prerequisite of Task 1.
- [[logging-context]] — the shared log context, `app_event` flow-log convention, and
  span-attribute PII prohibitions Decision 25's `withStripeSpan`/`StripeActivitySource` steps
  (Tasks 1, 3, 4, 5, 6, 9, 10) follow.
- [[browser-rum]] — the Trigger 1/2/3 checklist Tasks 11.17, 12.8, and 15.10 verify the new
  Stripe web calls against, rather than restating it as a new checklist.
