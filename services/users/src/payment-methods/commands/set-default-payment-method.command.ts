import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { Db } from "#shared/db/prisma";
import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
import { withStripeSpan } from "#shared/observability/stripe-tracing";
import { RoutineFailure, Workflow } from "#shared/observability/workflow-metadata";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { lockUserRow, STRIPE_TIMEOUT_MS, TRANSACTION_TIMEOUT_MS } from "#shared/stripe/stripe-tx-lock";
import { DB, STRIPE_CLIENT } from "#shared/tokens";

export interface SetDefaultPaymentMethodInput {
  userId: string;
  paymentMethodId: string;
}

export class SetDefaultPaymentMethodCommand {
  constructor(public readonly input: SetDefaultPaymentMethodInput) {}
}

// CONTRACT: The residual case (Stripe applies the update, the local commit
// still fails) is reconciled by reconcile-payment-method.command.ts's
// customer.updated handler. See [[2026-09-19-stripe-payments-design]]
export { TRANSACTION_TIMEOUT_MS };
export const STRIPE_UPDATE_TIMEOUT_MS = STRIPE_TIMEOUT_MS;

// CONTRACT: A string union, not `void` — see DetachPaymentMethodResult for why
// `void`/`null` cannot be distinguished from a routine-failure value once
// WorkflowInterceptor unwraps a RoutineFailure. The controller:
// `if (result !== "set_default") throw new NotFoundException(...)`.
export type SetDefaultPaymentMethodResult = "set_default" | "not_found";

@Workflow("set_default_payment_method")
@CommandHandler(SetDefaultPaymentMethodCommand)
export class SetDefaultPaymentMethodHandler implements ICommandHandler<SetDefaultPaymentMethodCommand> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClientHolder,
  ) {}

  async execute({
    input,
  }: SetDefaultPaymentMethodCommand): Promise<
    SetDefaultPaymentMethodResult | RoutineFailure<SetDefaultPaymentMethodResult>
  > {
    if (!this.stripe.client) throw new StripeUnavailableException();
    const client = this.stripe.client;

    // CONTRACT: Scoped by userId AND stripePaymentMethodId, checked BEFORE any
    // Stripe call — same ownership requirement as detach. A miss is a ROUTINE
    // 404 (mirrors get-me.query.ts), not an error: the controller maps it.
    const row = await this.db.stripePaymentMethod.findFirst({
      where: { userId: input.userId, stripePaymentMethodId: input.paymentMethodId, deletedAt: null },
    });
    if (!row) {
      appLogger.warn(
        { app_event: "set_default_payment_method_failed", reason: "not_found", user_id: input.userId },
        "Set-default-payment-method failed: not found or not owned by the caller",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "set_default_payment_method_failed", reason: "not_found" });
      return new RoutineFailure("not_found", "not_found");
    }

    const user = await this.db.user.findUniqueOrThrow({ where: { id: input.userId } });
    if (!user.stripeCustomerId) {
      appLogger.warn(
        {
          app_event: "set_default_payment_method_failed",
          reason: "not_found",
          user_id: input.userId,
        },
        "Set-default-payment-method failed: the caller has no Stripe customer yet",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "set_default_payment_method_failed", reason: "not_found" });
      return new RoutineFailure("not_found", "not_found");
    }
    const customerId = user.stripeCustomerId;

    // CONTRACT: `lockUserRow`, INSIDE the same interactive transaction as the
    // Stripe call and the isDefault flip, serializes two concurrent set-default
    // calls for one user — the second blocks until the first commits, so
    // Stripe's default_payment_method and this table's single isDefault=true
    // row can never disagree. The array form of `$transaction` cannot hold
    // this lock across the Stripe network call. Every call inside a
    // transaction goes to the writer regardless of the read-replica extension
    // (see [[2026-07-12-prisma-lazy-promise-als]] for why `runAsActor` must
    // wrap the whole thing). See [[2026-09-19-stripe-payments-design]]
    await runAsActor(AuditActor.PaymentMethodSetDefault, () =>
      this.db.$transaction(
        async (tx) => {
          await lockUserRow(tx, input.userId);

          try {
            await withStripeSpan(
              "stripe.customer.update",
              { "stripe.resource_type": "customer", "stripe.customer_id": customerId },
              () =>
                client.customers.update(
                  customerId,
                  { invoice_settings: { default_payment_method: input.paymentMethodId } },
                  { timeout: STRIPE_UPDATE_TIMEOUT_MS },
                ),
            );
          } catch (err) {
            // CONTRACT: Ownership already passed above, so a Stripe error here is
            // Stripe-side drift (e.g. the pm was detached out-of-band), not bad
            // user input — do NOT dress it up as a 403. Log and propagate as an
            // ordinary failure. See [[logging-context]]
            appLogger.error(
              { err, app_event: "set_default_payment_method_failed", reason: "stripe_error", user_id: input.userId },
              "Stripe rejected the set-default-payment-method request after ownership was confirmed",
            );
            trace.getActiveSpan()?.setAttributes({
              app_event: "set_default_payment_method_failed",
              reason: "stripe_error",
            });
            throw err;
          }

          await tx.stripePaymentMethod.updateMany({
            where: { userId: input.userId, isDefault: true },
            data: { isDefault: false },
          });
          await tx.stripePaymentMethod.update({
            where: { id: row.id },
            data: { isDefault: true },
          });
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      ),
    );

    appLogger.info(
      { app_event: "payment_method_set_default", user_id: input.userId },
      "Payment method set as default",
    );

    return "set_default";
  }
}
