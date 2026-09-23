import { z } from "zod/v4";

/**
 * CONTRACT: `paymentMethodId` is always a Stripe `pm_...` id — the client
 * confirms the SetupIntent itself and only ever hands this route the resulting
 * PaymentMethod id, never a card number or token. See [[openapi-specs]]
 */
export const AttachPaymentMethodInputSchema = z.object({
  paymentMethodId: z.string().regex(/^pm_/, "must be a Stripe PaymentMethod id (pm_...)"),
});

/** Shared by the `:id` path param on detach and set-default. */
export const PaymentMethodIdParamSchema = z.object({
  id: z.string().regex(/^pm_/, "must be a Stripe PaymentMethod id (pm_...)"),
});

export const SetupIntentResultSchema = z.object({
  clientSecret: z.string(),
});

export const PaymentMethodViewSchema = z.object({
  id: z.string(),
  // Stripe's PaymentMethod.type (spec D16) — "card", "link", "us_bank_account", etc.
  type: z.string(),
  // Card-only fields: null for a non-card payment method (no `pm.card` object).
  brand: z.string().nullable(),
  last4: z.string().nullable(),
  expMonth: z.number().int().nullable(),
  expYear: z.number().int().nullable(),
  isDefault: z.boolean(),
});

export const PaymentMethodListSchema = z.array(PaymentMethodViewSchema);

export const AttachPaymentMethodResultSchema = z.object({
  id: z.string(),
});

// Named components rather than inline anonymous schemas, so the generated spec
// shows proper models in Apidog. See [[openapi-specs]]
z.globalRegistry.add(AttachPaymentMethodInputSchema, { id: "AttachPaymentMethod" });
z.globalRegistry.add(SetupIntentResultSchema, { id: "SetupIntentResult" });
z.globalRegistry.add(PaymentMethodViewSchema, { id: "PaymentMethodView" });
z.globalRegistry.add(PaymentMethodListSchema, { id: "PaymentMethodList" });
z.globalRegistry.add(AttachPaymentMethodResultSchema, { id: "AttachPaymentMethodResult" });
