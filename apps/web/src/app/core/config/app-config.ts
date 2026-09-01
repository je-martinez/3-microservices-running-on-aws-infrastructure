/**
 * Build-time configuration, inlined by @ngx-env/builder.
 * WARNING: NG_APP_* values ship in the bundle, readable in devtools — flags and
 * publishable keys only, never a secret. Each arrives as a STRING ("false" is
 * truthy), so parsing happens here once; no other file reads import.meta.env.
 */
export interface AppConfig {
  /** Whether the Stripe payment path is offered at checkout. */
  readonly stripeEnabled: boolean;
}

export const APP_CONFIG: AppConfig = {
  stripeEnabled: import.meta.env.NG_APP_STRIPE_ENABLED === "true",
};
