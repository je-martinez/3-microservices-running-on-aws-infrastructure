import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import Stripe from "stripe";
import type { Db } from "#shared/db/prisma";
import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
import { isResourceMissing } from "#shared/stripe/stripe-errors";
import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
import { withStripeSpan } from "#shared/observability/stripe-tracing";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { NanoIdConfig } from "#shared/id/nano-id";
import { lockUserRow, STRIPE_TIMEOUT_MS, TRANSACTION_TIMEOUT_MS } from "#shared/stripe/stripe-tx-lock";
import { DB, STRIPE_CLIENT } from "#shared/tokens";
import { mapStripePaymentMethodFields } from "../stripe-payment-method-mapper.ts";

// CONTRACT: The single source of truth for which event types trigger
// reconciliation — the controller filters dispatch with the SAME set, so the
// two can never drift into dispatching (or skipping) different event types.
export const RECONCILED_TYPES = new Set([
  "payment_method.attached",
  "payment_method.detached",
  "payment_method.updated",
  "payment_method.automatically_updated",
  "customer.updated",
]);

export const STRIPE_RETRIEVE_TIMEOUT_MS = STRIPE_TIMEOUT_MS;
export { TRANSACTION_TIMEOUT_MS };

export class ReconcilePaymentMethodCommand {
  constructor(public readonly event: Stripe.Event) {}
}

function paymentMethodIdFromEvent(event: Stripe.Event): string {
  return (event.data.object as Stripe.PaymentMethod).id;
}

// CONTRACT: Stripe retries a webhook on any non-2xx, so a branch that CANNOT
// place an event (unknown customer, PM never known locally) logs and
// acknowledges 200; a branch where the Stripe API call itself fails (network,
// 5xx, timeout) rethrows so Stripe retries — acking a transient Stripe
// failure would silently skip reconciliation forever. See
// [[2026-09-19-stripe-payments-design]]
@CommandHandler(ReconcilePaymentMethodCommand)
export class ReconcilePaymentMethodHandler implements ICommandHandler<ReconcilePaymentMethodCommand> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClientHolder,
  ) {}

  async execute({ event }: ReconcilePaymentMethodCommand): Promise<void> {
    if (!this.stripe.client) throw new StripeUnavailableException();
    const client = this.stripe.client;

    switch (event.type) {
      case "payment_method.attached":
      case "payment_method.updated":
      case "payment_method.automatically_updated":
      case "payment_method.detached":
        await this.reconcilePaymentMethod(client, paymentMethodIdFromEvent(event));
        return;
      case "customer.updated":
        await this.reconcileDefault(client, (event.data.object as Stripe.Customer).id);
        return;
      default:
        return;
    }
  }

  // CONTRACT: `customer` is a string id on the raw webhook payload (never an
  // expanded object) — Stripe does not expand webhook payloads. Reads go to
  // the PRIMARY (`$primary()`): an acknowledged "unknown customer/PM" miss is
  // permanent (Stripe never redelivers a 200'd event), so reading a replica
  // lagging behind a just-committed row would wrongly ack-and-drop it.
  private async resolveUserIdByCustomer(customerId: string | null): Promise<string | null> {
    if (!customerId) return null;
    const user = await this.db.$primary().user.findFirst({ where: { stripeCustomerId: customerId } });
    return user?.id ?? null;
  }

  // CONTRACT: Re-reads the PaymentMethod from Stripe rather than trusting the
  // event payload's snapshot, and acts on its CURRENT state — an
  // attached/updated event delivered after a later detach (out-of-order
  // delivery, spec D4 "Stripe is authoritative") resolves to customer=null or
  // resource_missing here and is soft-deleted, never re-created as if still
  // attached. See [[2026-09-19-stripe-payments-design]]
  private async reconcilePaymentMethod(client: Stripe, paymentMethodId: string): Promise<void> {
    let pm: Stripe.PaymentMethod;
    try {
      pm = await withStripeSpan(
        "stripe.payment_method.retrieve",
        { "stripe.resource_type": "payment_method", "stripe.payment_method_id": paymentMethodId },
        () => client.paymentMethods.retrieve(paymentMethodId, {}, { timeout: STRIPE_RETRIEVE_TIMEOUT_MS }),
      );
    } catch (err) {
      if (!isResourceMissing(err)) throw err;
      await this.softDeleteIfPresent(paymentMethodId, "resource_missing_on_retrieve");
      return;
    }

    const customerId = typeof pm.customer === "string" ? pm.customer : null;
    if (!customerId) {
      await this.softDeleteIfPresent(paymentMethodId, "customer_null_on_retrieve");
      return;
    }

    const userId = await this.resolveUserIdByCustomer(customerId);
    if (!userId) {
      appLogger.warn(
        { app_event: "payment_method_reconciled", reason: "unknown_customer" },
        "Ignoring a payment_method webhook for a customer with no local user",
      );
      return;
    }

    // CONTRACT: An existing row owned by a DIFFERENT user than the one the
    // CURRENT Stripe state resolves to is left untouched — Stripe drift must
    // never reassign a payment method's owner.
    const existing = await this.db.$primary().stripePaymentMethod.findFirst({
      where: { stripePaymentMethodId: pm.id },
    });
    if (existing && existing.userId !== userId) {
      appLogger.warn(
        { app_event: "payment_method_reconciled", reason: "owner_mismatch" },
        "Ignoring a payment_method webhook whose local row is owned by a different user",
      );
      return;
    }

    await runAsActor(AuditActor.StripeWebhookReconcile, () =>
      this.db.stripePaymentMethod.upsert({
        where: { stripePaymentMethodId: pm.id },
        create: {
          id: NanoIdConfig.newStripePaymentMethodId(),
          stripePaymentMethodId: pm.id,
          userId,
          isDefault: false,
          ...mapStripePaymentMethodFields(pm),
        },
        update: mapStripePaymentMethodFields(pm),
      }),
    );

    appLogger.info({ app_event: "payment_method_reconciled", user_id: userId }, "Payment method reconciled");
  }

  private async softDeleteIfPresent(paymentMethodId: string, reason: string): Promise<void> {
    const row = await this.db.$primary().stripePaymentMethod.findFirst({
      where: { stripePaymentMethodId: paymentMethodId, deletedAt: null },
    });
    if (!row) {
      // Idempotent under retries: already soft-deleted, or never known
      // locally, is the SAME outcome as "nothing to do", not a failure.
      appLogger.info(
        { app_event: "payment_method_reconciled", reason: "already_detached_or_unknown" },
        "Ignoring a payment_method webhook for a row already gone locally",
      );
      return;
    }

    await runAsActor(AuditActor.StripeWebhookReconcile, () =>
      this.db.stripePaymentMethod.delete({ where: { id: row.id } }),
    );

    appLogger.info(
      { app_event: "payment_method_reconciled", user_id: row.userId, reason },
      "Payment method detached via webhook",
    );
  }

  // CONTRACT: Locks the user row FOR UPDATE — the SAME statement
  // set-default-payment-method.command.ts takes — inside the SAME
  // transaction as the Stripe read and the isDefault writes, so a concurrent
  // set-default for this user cannot interleave into two isDefault=true rows.
  // The Stripe call retrieves CURRENT state rather than trusting the event's
  // snapshot, so a stale/out-of-order customer.updated can never overwrite a
  // newer default: whichever caller wins the row lock reads Stripe's state as
  // of ITS OWN turn, not the event's timestamp. See
  // [[2026-09-19-stripe-payments-design]]
  private async reconcileDefault(client: Stripe, customerId: string): Promise<void> {
    const userId = await this.resolveUserIdByCustomer(customerId);
    if (!userId) {
      appLogger.warn(
        { app_event: "payment_method_reconciled", reason: "unknown_customer" },
        "Ignoring a customer.updated webhook for a customer with no local user",
      );
      return;
    }

    await runAsActor(AuditActor.StripeWebhookReconcile, () =>
      this.db.$transaction(
        async (tx) => {
          await lockUserRow(tx, userId);

          const customer = await withStripeSpan(
            "stripe.customer.retrieve",
            { "stripe.resource_type": "customer", "stripe.customer_id": customerId },
            () => client.customers.retrieve(customerId, {}, { timeout: STRIPE_RETRIEVE_TIMEOUT_MS }),
          );
          if (customer.deleted) return;

          const defaultPaymentMethod = customer.invoice_settings?.default_payment_method;
          const defaultPmId =
            typeof defaultPaymentMethod === "string" ? defaultPaymentMethod : (defaultPaymentMethod?.id ?? null);

          const currentDefault = await tx.stripePaymentMethod.findFirst({
            where: { userId, isDefault: true },
          });
          // No-op when the local default already matches Stripe's current
          // state — both the "same PM" and "both unset" cases.
          if (
            (defaultPmId && currentDefault?.stripePaymentMethodId === defaultPmId) ||
            (!defaultPmId && !currentDefault)
          ) {
            return;
          }

          await tx.stripePaymentMethod.updateMany({
            where: { userId, isDefault: true },
            data: { isDefault: false },
          });
          if (!defaultPmId) return;
          // A local miss on the default id is a routine no-op, not an error —
          // the target row may not exist locally yet.
          await tx.stripePaymentMethod.updateMany({
            where: { userId, stripePaymentMethodId: defaultPmId },
            data: { isDefault: true },
          });
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      ),
    );

    appLogger.info(
      { app_event: "payment_method_reconciled", user_id: userId },
      "Default payment method synced from customer.updated",
    );
  }
}
