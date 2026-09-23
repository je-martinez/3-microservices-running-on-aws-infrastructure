import { BadRequestException, Controller, Headers, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { CommandBus } from "@nestjs/cqrs";
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AppConfigService } from "#config/config.module";
import { Public } from "#shared/auth/public.decorator";
import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
import { STRIPE_CLIENT } from "#shared/tokens";
import { appLogger } from "#shared/logging/app-logger";
import { ReconcilePaymentMethodCommand, RECONCILED_TYPES } from "../commands/reconcile-payment-method.command.ts";

// CONTRACT: PUBLIC at the API Gateway — Stripe has no Cognito JWT to present,
// so the global AuthGuard would 401 every delivery. StripeWebhookGate checks
// the source IP and the `:token` segment before the body is parsed; this
// handler then verifies `stripe-signature` against the raw body BEFORE any
// dispatch. See [[2026-09-19-stripe-payments-design]]
@ApiTags("webhooks")
@Controller("v1/users/stripe")
export class StripeWebhookController {
  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClientHolder,
    private readonly commandBus: CommandBus,
    private readonly config: AppConfigService,
  ) {}

  @Post("webhook/:token")
  @Public()
  @HttpCode(200)
  @ApiOperation({
    operationId: "stripeWebhook",
    summary: "Stripe payment-method/customer webhook (reconciliation)",
  })
  @ApiParam({
    name: "token",
    description: "Secret URL token (STRIPE_WEBHOOK_URL_TOKEN). Never logged.",
  })
  @ApiHeader({
    name: "stripe-signature",
    required: true,
    description: "HMAC signature Stripe computes over the raw request body.",
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: "object",
      properties: { received: { type: "boolean" } },
      required: ["received"],
      additionalProperties: false,
    },
  })
  @ApiResponse({ status: 400, schema: { $ref: "#/components/schemas/Error" } })
  @ApiResponse({
    status: 403,
    description: "Source IP not in STRIPE_WEBHOOK_ALLOWED_CIDRS (`forbidden_source`).",
    schema: { $ref: "#/components/schemas/Error" },
  })
  @ApiResponse({
    status: 404,
    description: "Missing or wrong URL token — the same response as an unmapped route.",
  })
  @ApiResponse({ status: 503, schema: { $ref: "#/components/schemas/Error" } })
  async handle(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers("stripe-signature") signature: string | undefined,
  ): Promise<{ received: boolean }> {
    if (!this.stripe.client) throw new StripeUnavailableException();
    const webhookSecret = this.config.get("STRIPE_WEBHOOK_SECRET", { infer: true });
    if (!webhookSecret) throw new StripeUnavailableException();

    const rawBody = req.rawBody;
    if (!rawBody || !signature) {
      appLogger.warn(
        { app_event: "stripe_webhook_received", reason: "signature_verification_failed" },
        "Stripe webhook rejected: missing raw body or stripe-signature header",
      );
      throw new BadRequestException({ error: "invalid_signature" });
    }

    let event;
    try {
      event = this.stripe.client.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch {
      // CONTRACT: Verify BEFORE processing — never dispatch a command from an
      // unverified payload. Neither the log line nor this exception's body
      // carries the signature header, the raw body, or Stripe's own error
      // message (any of the three could help a caller forge a future
      // delivery). See [[2026-09-19-stripe-payments-design]]
      appLogger.warn(
        { app_event: "stripe_webhook_received", reason: "signature_verification_failed" },
        "Stripe webhook signature verification failed",
      );
      throw new BadRequestException({ error: "invalid_signature" });
    }

    appLogger.info(
      { app_event: "stripe_webhook_received", event_type: event.type, event_id: event.id },
      "Stripe webhook received",
    );

    if (RECONCILED_TYPES.has(event.type)) {
      await this.commandBus.execute(new ReconcilePaymentMethodCommand(event));
    }

    return { received: true };
  }
}
