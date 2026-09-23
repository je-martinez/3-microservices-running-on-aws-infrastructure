import { HttpException, HttpStatus, Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import Stripe from "stripe";
import type { Db } from "#shared/db/prisma";
import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
import { withStripeSpan } from "#shared/observability/stripe-tracing";
import { Workflow } from "#shared/observability/workflow-metadata";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { NanoIdConfig } from "#shared/id/nano-id";
import { DB, STRIPE_CLIENT } from "#shared/tokens";
import { ensureStripeCustomer } from "../ensure-stripe-customer";
import { mapStripePaymentMethodFields } from "../stripe-payment-method-mapper";

export interface AttachPaymentMethodInput {
  userId: string;
  paymentMethodId: string; // pm_...
  e2eSource: boolean;
}

export class AttachPaymentMethodCommand {
  constructor(public readonly input: AttachPaymentMethodInput) {}
}

export interface AttachPaymentMethodResult {
  id: string;
}

// CONTRACT: One error code for "pm_ does not exist" and "pm_ belongs to another
// customer" — a distinct code would let a caller enumerate other customers' ids
// by brute-forcing pm_... values and reading the difference in the response.
export class PaymentMethodRejectedException extends HttpException {
  constructor() {
    super({ error: "payment_method_rejected" }, HttpStatus.FORBIDDEN);
  }
}

// A card Stripe declines at attach time (Radar risk block, etc.) — distinct
// from PaymentMethodRejectedException: the id is valid and owned, the CARD is
// refused. 402, matching the HTTP status Stripe itself uses for card declines.
export class PaymentMethodDeclinedException extends HttpException {
  constructor() {
    super({ error: "payment_method_declined" }, HttpStatus.PAYMENT_REQUIRED);
  }
}

// CONTRACT: Stripe already attaches a PaymentMethod confirmed through a
// SetupIntent created with `customer`, so a second `.attach` call for the SAME
// customer raises StripeInvalidRequestError ("already been attached to a
// customer"). Fall back to retrieve+ownership-check in that case rather than
// treating it as a failure. See [[2026-09-19-stripe-payments-design]]
async function attachOrVerifyOwnership(
  client: Stripe,
  paymentMethodId: string,
  customerId: string,
): Promise<Stripe.PaymentMethod> {
  try {
    return await client.paymentMethods.attach(paymentMethodId, { customer: customerId });
  } catch (err) {
    if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) throw err;

    // CONTRACT: Never distinguish "no such PaymentMethod" from "belongs to
    // someone else" in the THROWN error — both paths raise the same
    // PaymentMethodRejectedException below, at the call site.
    const pm = await client.paymentMethods.retrieve(paymentMethodId);
    if (pm.customer !== customerId) throw err;
    return pm;
  }
}

@Workflow("attach_payment_method")
@CommandHandler(AttachPaymentMethodCommand)
export class AttachPaymentMethodHandler implements ICommandHandler<AttachPaymentMethodCommand> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClientHolder,
  ) {}

  async execute({ input }: AttachPaymentMethodCommand): Promise<AttachPaymentMethodResult> {
    if (!this.stripe.client) throw new StripeUnavailableException();
    const client = this.stripe.client;

    const user = await this.db.user.findUniqueOrThrow({ where: { id: input.userId } });
    const customerId = await ensureStripeCustomer(this.stripe, this.db, {
      userId: input.userId,
      email: user.email,
      e2eSource: input.e2eSource,
    });

    let pm: Stripe.PaymentMethod;
    try {
      pm = await withStripeSpan(
        "stripe.payment_method.attach",
        { "stripe.resource_type": "payment_method" },
        async (span) => {
          const attached = await attachOrVerifyOwnership(client, input.paymentMethodId, customerId);
          span.setAttribute("stripe.payment_method_id", attached.id);
          return attached;
        },
      );
    } catch (err) {
      // CONTRACT: StripeCardError (a decline) and StripeInvalidRequestError
      // (bad/unowned id) are DIFFERENT user-facing outcomes — 402 vs 403 —
      // but both are 4xx caused by the caller's input, never a 500, and never
      // the raw Stripe message (may embed another customer's id or account
      // details). Anything else (StripeAPIError, StripeConnectionError, ...) is
      // an operational failure and must propagate untouched. See [[logging-context]]
      if (err instanceof Stripe.errors.StripeCardError || err instanceof Stripe.errors.StripeInvalidRequestError) {
        const reason = err instanceof Stripe.errors.StripeCardError ? "stripe_card_declined" : "stripe_invalid_request";
        appLogger.warn(
          { app_event: "attach_payment_method_failed", reason, user_id: input.userId },
          "Stripe rejected the payment method attach request",
        );
        trace.getActiveSpan()?.setAttributes({ app_event: "attach_payment_method_failed", reason });
        throw err instanceof Stripe.errors.StripeCardError
          ? new PaymentMethodDeclinedException()
          : new PaymentMethodRejectedException();
      }
      throw err;
    }

    // CONTRACT: `upsert` keyed on stripePaymentMethodId — the reconciliation
    // webhook may have already written this row; a plain `create` here would
    // throw on the unique constraint. `id` has no DB default, so the generated
    // create-input type requires it even though the extension would stamp one;
    // pass it explicitly rather than widen the type, mirroring
    // create-notification.command.ts. See [[nano-id]]
    const row = await runAsActor(AuditActor.PaymentMethodAttached, () =>
      this.db.stripePaymentMethod.upsert({
        where: { stripePaymentMethodId: pm.id },
        create: {
          id: NanoIdConfig.newStripePaymentMethodId(),
          stripePaymentMethodId: pm.id,
          userId: input.userId,
          isDefault: false,
          ...mapStripePaymentMethodFields(pm),
        },
        update: mapStripePaymentMethodFields(pm),
      }),
    );

    appLogger.info(
      { app_event: "payment_method_attached", user_id: input.userId },
      "Payment method attached",
    );

    return { id: row.stripePaymentMethodId };
  }
}
