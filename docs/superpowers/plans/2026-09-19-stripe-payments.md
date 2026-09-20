---
title: "Stripe Payments Implementation Plan"
type: plan
area: shared
status: draft
created: 2026-09-19
updated: 2026-09-19
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
- Create: `services/users/src/shared/stripe/stripe-client.provider.ts`, `services/users/src/shared/stripe/stripe-client.provider.spec.ts`, `services/users/src/shared/tokens.ts` (extend, do not recreate)
- Modify: `services/users/src/config/env.schema.ts`
- Test: `services/users/src/shared/stripe/stripe-client.provider.spec.ts`

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

- [ ] 1.7 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

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

- [ ] 3.3 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

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

- [ ] 4.10 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

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

- [ ] 5.5 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 6 — Extend `e2e-cleanup` to Stripe

**Files:**
- Modify: the existing e2e-cleanup command/handler (locate via `grep -rn "e2e-cleanup" services/users/src`) and its spec.

**Interfaces:**
- Consumes: `STRIPE_CLIENT` (Task 1), `User.stripeCustomerId` (Task 2).

### Steps

- [ ] 6.1 Read the existing `DELETE /v1/users/e2e-cleanup` handler in full before editing — locate it with `grep -rln "e2e-cleanup\|E2eCleanup" services/users/src`.

- [ ] 6.2 Write a failing spec asserting that, for every user row carrying `"E2E Source"` with a non-null `stripeCustomerId`, `stripe.client.customers.del(stripeCustomerId)` is called, and that a user with no `stripeCustomerId` is skipped without error (Stripe never called for it).

- [ ] 6.3 Implement: extend the existing handler to, after (or alongside) its current soft-delete pass, iterate tagged rows with a `stripeCustomerId` and call `stripe.client.customers.del(...)`, guarding with `if (!this.stripe.client) return;` at the top so cleanup is a no-op when Stripe isn't configured, never a failure.

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
- Modify: `services/orders/src/Orders.Api/Program.cs` (StripeClient registration), the order-creation endpoint and its command handler (`grep -rln "POST.*orders\|CreateOrder" services/orders/src/Orders.Api`), `services/orders/src/Orders.Domain` (payment snapshot fields on the order aggregate)
- Create: an EF Core migration for the payment snapshot columns
- Test: xUnit tests for the order-creation handler (mocking `StripeClient`), `Testcontainers-MySQL` integration test

**Interfaces:**
- Consumes: `UserResponse.stripe_customer_id` (Task 7), `paymentMethodId` in the `POST /v1/orders` request body (new field).
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

- [ ] 9.10 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 10 — Orders: refund-on-409

**Files:**
- Modify: the same order-creation handler from Task 9
- Test: a dedicated xUnit test forcing the reservation to fail after a successful charge

**Interfaces:**
- Consumes: `PaymentSnapshot` (Task 9), the existing stock-reservation call that can return 409.

> [!warning] Highest-risk task in this plan
> This is the repo's known review failure mode per [[phase-c-review-flow]] and [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]: a concurrency requirement specified from day one, shipped as an unhandled path, passing its own review because the diff is self-consistent on its own terms. **Reviewers must tick this task off against Decision 9 in the spec directly, not just read the diff** — ordinary tests structurally do not exercise concurrency, so the only proof this works is the explicit test in step 10.1, not the absence of a crash elsewhere.

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
          // CONTRACT: A charge must never be left dangling (spec D9). This is
          // the ONLY path that refunds — a reservation conflict occurring
          // BEFORE any charge (Stripe disabled, or reservation checked first
          // in some other flow) has nothing to refund.
          var refundService = new RefundService(_stripeClient);
          await refundService.CreateAsync(
              new RefundCreateOptions { PaymentIntent = paymentIntent.Id }, cancellationToken: ct);
      }
      throw;
  }
  ```

- [ ] 10.3 Run `dotnet test --filter CreateOrder_WhenReservationConflictsAfterSuccessfulCharge_RefundsTheCharge` — passes. Then run the full `dotnet test` suite for `services/orders` — confirm no regression on the 9.3–9.6 tests.

- [ ] 10.4 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## GATE — stop point before Web work

Task 11 (web) posts `paymentMethodId` to `POST /v1/orders`, which does not behave correctly until Tasks 9–10 are merged. **Present the Tasks 9–10 batch for review per [[phase-c-review-flow]] and wait for merge before starting Task 11.** Task 12 (plain-branch card validation) touches only pure functions and the plain branch — it does not depend on Tasks 9–10 and may be implemented in parallel with this wait, but its PR is still batched together with Task 11's at review time since both change `checkout-payment.html`/`.ts`.

## Task 11 — Web: Payment Element + saved-card selector

**Files:**
- Modify: `apps/web/src/env.d.ts`, `apps/web/src/app/core/config/app-config.ts`, `apps/web/src/app/features/checkout/checkout-payment.ts`, `apps/web/src/app/features/checkout/checkout-payment.html`
- Create: `apps/web/src/app/features/checkout/payment-method-selector.ts` (+ `.html`), `apps/web/src/app/core/api/payment-methods-api.ts`
- Test: component specs for `payment-method-selector`, an updated spec for `checkout-payment`

**Interfaces:**
- Consumes: `GET/POST/DELETE/PUT /v1/users/me/payment-methods*` (Task 4), `POST /v1/orders` with `paymentMethodId` (Task 9).
- Produces: `APP_CONFIG.stripePublishableKey: string | null`, consumed only inside `checkout-payment.ts`/`payment-method-selector.ts`.

### Steps

- [ ] 11.1 Add `NG_APP_STRIPE_PUBLISHABLE_KEY` to `apps/web/src/env.d.ts`:
  ```ts
  interface ImportMetaEnv {
    readonly NG_APP_STRIPE_ENABLED?: string;
    readonly NG_APP_STRIPE_PUBLISHABLE_KEY?: string;
    readonly NG_APP_API_GATEWAY_URL?: string;
    readonly NG_APP_GEOCODE_ENABLED?: string;
    readonly NG_APP_WS_URL?: string;
  }
  ```

- [ ] 11.2 Extend `AppConfig` and its reader in `app-config.ts`. Per [[env-files]]/the repo's esbuild rule, spell out the full `import.meta.env.NG_APP_STRIPE_PUBLISHABLE_KEY` access — do not construct the key name dynamically:
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

- [ ] 11.3 Write the failing spec for `payment-method-selector.ts` asserting: it lists saved cards from `PaymentMethodsApi.list()`, preselects the default, exposes a `selectedPaymentMethodId` output, and shows the Payment Element (mounted against a SetupIntent client_secret from `PaymentMethodsApi.createSetupIntent()`) when the user has zero cards or clicks "Add card".

- [ ] 11.4 Create `apps/web/src/app/core/api/payment-methods-api.ts` following the existing `UsersApi`/`OrdersApi` shape (HTTP client wrapper, one method per route from Task 4):
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

- [ ] 11.5 Implement `payment-method-selector.ts`/`.html` following [[angular-component-authoring]] (signals, `OnPush`, no domain logic beyond presentation), loading Stripe.js via `loadStripe(APP_CONFIG.stripePublishableKey)`, mounting the Payment Element into a container div when adding a card, and never using the Card Element.

- [ ] 11.6 Replace the static card at `checkout-payment.html:259` (`@if (stripeEnabled())` branch) with `<app-payment-method-selector (selectedPaymentMethodId)="onCardSelected($event)" />`.

- [ ] 11.7 In `checkout-payment.ts`, add a `selectedPaymentMethodId` signal, wire `onCardSelected`, extend `canPay` to also require it when `stripeEnabled()` is true:
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

- [ ] 11.8 Update `pay()` to send `paymentMethodId` and map 402 through `authErrorMessage`, mirroring the existing 409 entry:
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

- [ ] 11.9 Confirm `devFill()` remains unchanged and does not touch `selectedPaymentMethodId` or the Stripe branch — it stays scoped to `addressModel`/`cardModel` exactly as today (the plain branch), per Decision "Constraints" in the Web section.

- [ ] 11.10 Run `nvm use && pnpm --filter web test` — confirm the new and updated specs pass.

- [ ] 11.11 Modify `OrdersApi.createOrder` (or add a sibling parameter) so that on the plain branch it also sends the detected `card: { brand, last4, expMonth, expYear }` metadata alongside the order body — never the PAN, never the CVC (Decision 21; Task 12 supplies the detector this reads from). On the Stripe branch this field is omitted entirely; Orders' Task 9.9 validation only runs when `STRIPE_ENABLED=false`.

- [ ] 11.12 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 12 — Card-field validation on the plain branch (Decision 21)

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

- [ ] 12.1 Write the failing spec for Luhn and brand detection, `card-validation.spec.ts`:
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

- [ ] 12.2 Implement brand detection and Luhn in `card-validation.ts`:
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

- [ ] 12.3 Write the failing spec for length-per-brand edge cases:
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
  Run `nvm use && pnpm --filter web test card-validation` — passes against the 12.2 implementation (no code change needed if 12.2 was implemented correctly; if it fails, fix `LENGTHS_BY_BRAND` before proceeding).

- [ ] 12.4 Write the failing spec for CVC:
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

- [ ] 12.5 Write the failing spec for expiry, using an injected clock rather than a hardcoded year:
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

- [ ] 12.6 Write the failing spec for brand-aware grouping in `numeric-input.spec.ts`:
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

- [ ] 12.7 Implement brand-aware grouping, replacing `numeric-input.ts`'s `groupCardDigits` and rewriting its comment to describe the final state (per the repo's code-comment rules — no "used to do X" narration):
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

- [ ] 12.8 Write the failing component-level spec for `canPay` in `checkout-payment.spec.ts` (extend the existing spec file), asserting `canPay()` is `false` on the plain branch with an invalid card and `true` once the card form is valid, with a valid address on file:
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

- [ ] 12.9 Add real validators to `cardForm` in `checkout-payment.ts`, mirroring `addressForm`'s pattern:
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

- [ ] 12.10 Extend `canPay` in `checkout-payment.ts` to require `cardForm().valid()` only on the plain branch:
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

- [ ] 12.11 Add error messages to `checkout-payment.html`'s plain-branch card fields, using the same `app-field`/error-rendering pattern the address form already uses above it (copy that exact markup shape rather than inventing a new one).

- [ ] 12.12 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 13 — Infra, compose and CSP

**Files:**
- Modify: `infra/modules/api-gateway/main.tf`, `infra/modules/compute/nginx/nginx.conf`, `apps/web`'s nginx config (locate via `find apps/web -iname "nginx*.conf"`), `docker-compose.yml`, `Makefile`, `.env.example`

### Steps

- [ ] 13.1 Add the new Users routes (`/v1/users/me/payment-methods*`, `/v1/users/stripe/webhook`) to `infra/modules/api-gateway/main.tf`'s route map, following the existing route-block pattern for other `/v1/users/*` routes.

- [ ] 13.2 Add a `location` block for `/v1/users/stripe/webhook` (and the payment-methods paths, if they need a distinct block from the existing `/v1/users/` catch-all) in `infra/modules/compute/nginx/nginx.conf`. Per the spec's Infra section, a missing `location` block for a new top-level path silently falls through to `location /`, which routes to Users — verify the new paths already fall under an existing `/v1/users/` block rather than needing a new one, and only add a new block if they do not.

- [ ] 13.3 Add the CSP header change to `apps/web`'s nginx config, allowing `https://*.stripe.com` in `script-src`, `frame-src`, and `connect-src`:
  ```
  add_header Content-Security-Policy "... script-src 'self' https://*.stripe.com; frame-src 'self' https://*.stripe.com; connect-src 'self' https://*.stripe.com ...";
  ```
  (merge into the existing directive rather than replacing it — preserve every existing source already listed for each directive).

- [ ] 13.4 Add the `stripe-cli` service to `docker-compose.yml` behind `profiles: [stripe]`, following the `observability`/`preview` precedent:
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

- [ ] 13.5 Add `make stripe-up` and `make stripe-logs` targets to the `Makefile`, mirroring the existing `observability-up`/`observability-*` targets' shape (`docker compose --profile stripe up -d` / `docker compose logs -f stripe-cli`).

- [ ] 13.6 Add every new variable to `.env.example` with a comment explaining AUTO vs CUSTOM per [[env-files]]: `STRIPE_ENABLED` (AUTO-generated default `false`), `STRIPE_SECRET_KEY` (CUSTOM, hand-injected `rk_...`), `STRIPE_WEBHOOK_SECRET` (CUSTOM, hand-injected `whsec_...` from `stripe listen`'s own output), `NG_APP_STRIPE_PUBLISHABLE_KEY` (CUSTOM, the publishable `pk_...` key, safe for the bundle).

- [ ] 13.7 Run `nvm use && node scripts/validate-vault.mjs` is not applicable here (infra-only task); instead run this repo's existing Terraform validation/lint step for the touched modules if one exists (`grep -n "^validate\|^plan" Makefile`), and `docker compose config --profile stripe` to confirm the new compose service parses.

- [ ] 13.8 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Task 14 — The three test layers

**Files:**
- Create: `e2e/specs/internal/users/payment-methods.spec.ts`, `e2e/specs/internal/orders/order-payment.spec.ts`, `e2e/specs/gateway/checkout-payment.spec.ts`
- Modify: `e2e/support/global-teardown.ts` (if a new cleanup call is needed beyond the extended `e2e-cleanup` from Task 6), `e2e/load-tests/` scenario touching checkout (verify only, per step 14.5)

### Steps

- [ ] 14.1 Write internal E2E specs against `localhost:3000` (Users) covering: create setup-intent, attach a card (using Stripe's test PaymentMethod token flow against the CI sandbox per Decision 17), list, set default, detach, and the webhook signature-rejection path (a request with a bad `stripe-signature` header gets 400). Tag every created row with `x-e2e-source: true` and confirm `E2E_TESTING_ENABLED` gates it, per [[testing]]'s "E2E cleanup by tag" mechanism.

- [ ] 14.2 Write internal E2E specs against `localhost:3001` (Orders) covering: `POST /v1/orders` with a valid `paymentMethodId` succeeds and returns an order with a payment snapshot; with the flag on and `paymentMethodId` omitted, returns 400; with a Stripe test card that triggers a decline (`4000000000000002`), returns 402; the metadata-only card validation from Task 9.9 (known/unknown brand, expired/valid, malformed `last4`); and the concurrency scenario from Task 10.1 reproduced at the HTTP layer if feasible, or explicitly noted as covered only at the unit level with a comment pointing to Task 10.1's test name.

- [ ] 14.3 Write the gateway E2E spec with a real Cognito JWT covering the full Stripe-branch UI journey: log in, go to checkout, add a card via the mounted Payment Element (fill Stripe's test iframe using Playwright's frame-locator APIs against the CI sandbox), see it appear in the selector, switch to it, and pay. Assert on a genuine 401→success sequence if a route is initially unwired: per the spec's Infra section, a 404 carrying the gateway's own `{"message":"Not Found"}` body means the request never reached the service (fix the gateway/nginx wiring from Task 13), while a 401 after fixing it is the **correct** intermediate signal that the route resolved and reached the authorizer.

- [ ] 14.4 Write a second gateway E2E spec covering the **plain-branch** card validation from Task 12 (Decision 21): with `STRIPE_ENABLED=false`, typing an invalid card number (e.g. `4242 4242 4242 4241`) into the plain form leaves the Pay button disabled; correcting it to `4242 4242 4242 4242` with a valid future expiry and a 3-digit CVC enables Pay and a successful order follows. This is independent of Task 14.3's Stripe-branch journey — it exercises the branch the Payment Element never touches.

- [ ] 14.5 Add an explicit test (any layer) asserting that with `STRIPE_ENABLED=false`, `POST /v1/orders` succeeds with no `paymentMethodId` and no payment-method routes are reachable (404 or route-not-mounted, per how Task 4.8 resolved conditional mounting) — proving the flag gate, not assuming it.

- [ ] 14.6 Verify, by reading `e2e/load-tests/` (not by running the load suite against real Stripe), that no load-test scenario sends `x-e2e-source` or `x-test-mode` and that the checkout scenario either runs exclusively with `STRIPE_ENABLED=false` or is explicitly excluded from any Stripe-enabled load run — add a one-line comment in the relevant `.gatling.ts` scenario recording this if none exists yet. This is a verification step, not a new scenario — real charges under load would be expensive (spec Testing section).

- [ ] 14.7 Run all three layers: `nvm use && pnpm --filter e2e-impl test:internal` (or this repo's actual script name — check `e2e/package.json`), the gateway suite, and confirm green.

- [ ] 14.8 Leave the work uncommitted in the working tree and report what changed — the main session commits via the A/B/C/D/E confirmation menu per [[git-workflow]].

## Execution notes

- Per [[phase-c-review-flow]], issues for Tasks 1–7 and Tasks 9–14 chain without per-merge prompts; PRs are batched for review at each of the two GATEs above, and nothing is auto-merged — the user reviews and merges each batch explicitly. Task 12 (plain-branch card validation) may be worked in parallel with the Task 9–10 wait, since it has no dependency on them, but its PR still joins the second batch.
- The Linear issues for this milestone do not exist yet. Once `linear-pm` creates them, a milestone-plan note is required at `docs/plans/stripe-payments-milestone.md` per [[milestone-plan]] (task-sequence table, dependency table, and dependency diagram) — this superpowers plan documents *how* to implement each task, not the milestone's cross-issue dependency structure, which is what that note is for.
- The user injects the restricted keys (`rk_...` for each service) and the webhook secret by hand into the CUSTOM box of `.env.local.users` and `.env.local.orders` — never the AUTO box. The dedicated local-dev and CI Stripe sandboxes (Decision 17) are a prerequisite of Task 1: without a sandbox and its keys, Task 1's `STRIPE_ENABLED=true` path cannot be exercised past the "no key" branch.

## Self-review

**Spec coverage** — all 21 decisions map to at least one task:

| Decision | Task(s) |
|---|---|
| 1 (ownership split) | 3, 4, 9 |
| 2 (lazy customer creation) | 3, 4 |
| 3 (full metadata persisted) | 2, 4 |
| 4 (drift mitigation / webhook) | 5 |
| 5 (Orders payment snapshot) | 9 |
| 6 (gRPC stripe_customer_id) | 7, 9 |
| 7 (charge-then-persist) | 9 |
| 8 (402 on card errors) | 9 |
| 9 (refund-on-409) | 10 |
| 10 (Stripe CLI, not a tunnel) | 13 |
| 11 (E2E doesn't wait on webhook) | 14 (design already reflected in Task 4's attach flow) |
| 12 (E2E tagged in Stripe too) | 3, 4, 6, 14 |
| 13 (graceful degradation on missing key) | 1, 9 |
| 14 (stripe-mock excluded) | 14 (no task introduces it; Decision 17's sandbox is used instead) |
| 15 (restricted keys, one per service) | 1, 9, 13 |
| 16 (never payment_method_types; prohibited APIs) | Global Constraints, 4, 9, 11 |
| 17 (dedicated sandboxes) | 14, Execution notes |
| 18 (pinned versions, per-instance StripeClient) | Global Constraints, 1, 9 |
| 19 (PaymentIntents not Checkout Sessions) | 9 |
| 20 (Stripe Tax deferred; tax stays in-house) | 9 (amount = Orders' existing tax-inclusive total; no Stripe Tax call introduced anywhere) |
| 21 (plain-branch card validation, client + metadata-only server mirror) | 9 (server-side metadata mirror, step 9.9), 11 (frontend sends metadata, step 11.11), 12 (client validation), 14 (gateway E2E case, step 14.4) |

**Placeholder scan:** no "TBD"/"similar to Task N" shortcuts remain except explicitly-flagged repo-verification steps (4.8's conditional-module choice, 4.7's decorator names, 9.1/10.1's exact mock/fixture APIs, 12.9's exact signal-forms `validate()` signature) — each names the exact `grep` to run and the exact existing file to copy from, rather than leaving the shape undefined.

**Type consistency:** `StripeClientHolder` (Task 1) is the single shape threaded through Tasks 3, 4, 5, 6; `PaymentMethodView` (Task 4.3) is what Task 11's `PaymentMethodsApi.list()` consumes; `PaymentSnapshot` (Task 9) is what Task 10's refund path reads `PaymentIntentId` from; `stripe_customer_id` (Task 7) is the exact field both Task 9's gRPC read and Task 4/5's local persistence trace back to; `CardBrand`/`detectCardBrand`/`isValidCardNumber`/`isValidCvc`/`isValidExpiry` (Task 12) are the exact names Task 11's `checkout-payment.ts` imports and Task 12.7's `numeric-input.ts` rewrite depends on; the `{ brand, last4, expMonth, expYear }` metadata shape is identical between Task 11.11 (sender) and Task 9.9 (`CardMetadataValidator`, receiver).

## Related

- [[2026-09-19-stripe-payments-design]] — the design spec this plan implements task-by-task.
- [[testing]] — the three-layer gate every task's tests follow.
- [[env-files]] — the AUTO/CUSTOM box convention for every new Stripe env var.
- [[git-workflow]] — the commit/PR flow every task's final step defers to.
- [[phase-c-review-flow]] — the chained-issues/batched-review discipline around this plan's two GATEs.
- [[cqrs]] — the CommandBus/QueryBus dispatch discipline Task 4's tests follow.
- [[angular-component-authoring]] — the component pattern Task 11 follows.
- [[openapi-specs]] — where Task 4 and Task 5's new routes are specified.
- [[soft-delete]] — the deletion pattern `stripe_payment_methods` uses (Task 2, Task 4.5, Task 5.3).
- [[audit-fields]] — the standard audit columns on `stripe_payment_methods` (Task 2).
- [[nano-id]] — the primary-key convention for `stripe_payment_methods` (Task 2, Task 4.4).
- [[money-representation]] — the amount/currency representation Orders' payment snapshot follows (Task 9).
- [[local-dev]] — the `profiles:`-gated optional-service pattern `stripe-cli` follows (Task 13).
- [[skills-catalog]] — the Agent Skills installation mechanism already used for `stripe-best-practices`/`stripe-docs`.
