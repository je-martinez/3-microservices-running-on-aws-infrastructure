import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { Db } from "#shared/db/prisma";
import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
import { isResourceMissing } from "#shared/stripe/stripe-errors";
import { withStripeSpan } from "#shared/observability/stripe-tracing";
import { RoutineFailure, Workflow } from "#shared/observability/workflow-metadata";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { DB, STRIPE_CLIENT } from "#shared/tokens";

export interface DetachPaymentMethodInput {
  userId: string;
  paymentMethodId: string;
}

export class DetachPaymentMethodCommand {
  constructor(public readonly input: DetachPaymentMethodInput) {}
}

// CONTRACT: A string union, not `void` — `void`'s only runtime value is
// `undefined`, indistinguishable from a real success once WorkflowInterceptor
// unwraps a RoutineFailure to its `.value` (which defaults to `null`, itself
// falsy but NOT `=== "not_found"`). Mirrors DeleteAccountResult. The
// controller: `if (result !== "detached") throw new NotFoundException(...)`.
export type DetachPaymentMethodResult = "detached" | "not_found";

@Workflow("detach_payment_method")
@CommandHandler(DetachPaymentMethodCommand)
export class DetachPaymentMethodHandler implements ICommandHandler<DetachPaymentMethodCommand> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClientHolder,
  ) {}

  async execute({
    input,
  }: DetachPaymentMethodCommand): Promise<DetachPaymentMethodResult | RoutineFailure<DetachPaymentMethodResult>> {
    if (!this.stripe.client) throw new StripeUnavailableException();
    const client = this.stripe.client;

    // CONTRACT: Scoped by userId AND stripePaymentMethodId, checked BEFORE any
    // Stripe call — without this, passing another user's pm_... id would detach
    // and soft-delete their card (ownership requirement, Users HTTP surface spec).
    const row = await this.db.stripePaymentMethod.findFirst({
      where: { userId: input.userId, stripePaymentMethodId: input.paymentMethodId, deletedAt: null },
    });
    if (!row) {
      // CONTRACT: A missing/foreign row is a ROUTINE 404, not an error — the
      // controller turns this into 404 (mirrors get-me.query.ts). Returning
      // RoutineFailure keeps the workflow span OK and its reason accurate,
      // instead of letting the interceptor's catch-all stamp
      // reason=unhandled_error on an unthrown miss. See [[logging-context]]
      appLogger.warn(
        { app_event: "detach_payment_method_failed", reason: "not_found", user_id: input.userId },
        "Payment method detach failed: not found or not owned by the caller",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "detach_payment_method_failed", reason: "not_found" });
      return new RoutineFailure("not_found", "not_found");
    }

    try {
      await withStripeSpan(
        "stripe.payment_method.detach",
        { "stripe.resource_type": "payment_method", "stripe.payment_method_id": input.paymentMethodId },
        () => client.paymentMethods.detach(input.paymentMethodId),
      );
    } catch (err) {
      // CONTRACT: Ownership already passed above, so Stripe reporting the PM
      // gone (`resource_missing` — already detached/deleted directly in
      // Stripe) is DRIFT, not a bad caller input: soft-delete locally and
      // answer success (detach is idempotent). Any OTHER
      // StripeInvalidRequestError propagates untouched. See [[logging-context]]
      if (isResourceMissing(err)) {
        appLogger.warn(
          {
            app_event: "payment_method_detached",
            reason: "already_detached_in_stripe",
            user_id: input.userId,
          },
          "Payment method was already detached in Stripe; reconciling the local row",
        );
        trace.getActiveSpan()?.setAttributes({
          app_event: "payment_method_detached",
          reason: "already_detached_in_stripe",
        });
        await runAsActor(AuditActor.PaymentMethodDetached, () =>
          this.db.stripePaymentMethod.delete({ where: { id: row.id } }),
        );
        return "detached";
      }
      throw err;
    }

    // `delete()` redirects to the soft-delete update (stamps deletedAt/deletedBy
    // from the actor context) — see prisma-extensions.ts. See [[soft-delete]]
    await runAsActor(AuditActor.PaymentMethodDetached, () =>
      this.db.stripePaymentMethod.delete({ where: { id: row.id } }),
    );

    appLogger.info(
      { app_event: "payment_method_detached", user_id: input.userId },
      "Payment method detached",
    );

    return "detached";
  }
}
