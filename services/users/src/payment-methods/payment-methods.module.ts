import { Global, Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { stripeClientProvider } from "#shared/stripe/stripe-client.provider";
import { CurrentUserInterceptor } from "../users/http/current-user.interceptor.ts";
import { CreateSetupIntentHandler } from "./commands/create-setup-intent.command.ts";
import { AttachPaymentMethodHandler } from "./commands/attach-payment-method.command.ts";
import { DetachPaymentMethodHandler } from "./commands/detach-payment-method.command.ts";
import { SetDefaultPaymentMethodHandler } from "./commands/set-default-payment-method.command.ts";
import { ListPaymentMethodsHandler } from "./queries/list-payment-methods.query.ts";
import { PaymentMethodsController } from "./http/payment-methods.controller.ts";
import { ReconcilePaymentMethodHandler } from "./commands/reconcile-payment-method.command.ts";
import { StripeWebhookController } from "./webhooks/stripe-webhook.controller.ts";

// CONTRACT: `@Global()` makes STRIPE_CLIENT visible to UsersModule's
// e2e-cleanup command without UsersModule importing this module — the two
// are conditionally-mounted siblings under AppModule. Safe only because this
// module's own mount is already gated on STRIPE_ENABLED (app.module.ts); do
// NOT drop that gate, or the global registration becomes always-on.
@Global()
@Module({
  imports: [CqrsModule],
  controllers: [PaymentMethodsController, StripeWebhookController],
  providers: [
    stripeClientProvider,
    CreateSetupIntentHandler,
    AttachPaymentMethodHandler,
    DetachPaymentMethodHandler,
    SetDefaultPaymentMethodHandler,
    ListPaymentMethodsHandler,
    ReconcilePaymentMethodHandler,
    CurrentUserInterceptor,
  ],
  exports: [stripeClientProvider],
})
export class PaymentMethodsModule {}
