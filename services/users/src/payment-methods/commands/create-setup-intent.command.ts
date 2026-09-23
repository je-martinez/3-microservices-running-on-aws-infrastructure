import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import type { Db } from "#shared/db/prisma";
import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
import { withStripeSpan } from "#shared/observability/stripe-tracing";
import { Workflow } from "#shared/observability/workflow-metadata";
import { DB, STRIPE_CLIENT } from "#shared/tokens";
import { ensureStripeCustomer } from "../ensure-stripe-customer.ts";

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

// CONTRACT: Never log or trace `client_secret` — it is a bearer credential for
// completing the SetupIntent client-side (spec D25). This route emits only its
// workflow span (create_setup_intent_*); no dedicated app_event beyond that —
// a SetupIntent with no subsequent attach has nothing to report.
@Workflow("create_setup_intent")
@CommandHandler(CreateSetupIntentCommand)
export class CreateSetupIntentHandler implements ICommandHandler<CreateSetupIntentCommand> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClientHolder,
  ) {}

  async execute({ input }: CreateSetupIntentCommand): Promise<CreateSetupIntentResult> {
    if (!this.stripe.client) throw new StripeUnavailableException();
    const client = this.stripe.client;

    const user = await this.db.user.findUniqueOrThrow({ where: { id: input.userId } });
    const customerId = await ensureStripeCustomer(this.stripe, this.db, {
      userId: input.userId,
      email: user.email,
      e2eSource: input.e2eSource,
    });

    // No payment_method_types — dynamic payment methods stay enabled (spec D16).
    const setupIntent = await withStripeSpan(
      "stripe.setup_intent.create",
      { "stripe.resource_type": "setup_intent", "stripe.customer_id": customerId },
      async (span) => {
        const created = await client.setupIntents.create({ customer: customerId });
        span.setAttribute("stripe.setup_intent_id", created.id);
        return created;
      },
    );

    if (!setupIntent.client_secret) throw new Error("Stripe did not return a client_secret");
    return { clientSecret: setupIntent.client_secret };
  }
}
