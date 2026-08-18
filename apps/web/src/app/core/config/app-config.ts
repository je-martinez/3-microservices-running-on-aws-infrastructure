/**
 * Build-time configuration, inlined by @ngx-env/builder.
 *
 * Every NG_APP_* value is a STRING — "false" is truthy — so it is parsed here,
 * once, and the rest of the app reads the boolean. Nothing else in the app may
 * read import.meta.env directly.
 *
 * PUBLIC: these values ship inside the bundle. Never a secret.
 */
export interface AppConfig {
  /** Whether the Stripe payment path is offered at checkout. */
  readonly stripeEnabled: boolean;
}

export const APP_CONFIG: AppConfig = {
  stripeEnabled: import.meta.env.NG_APP_STRIPE_ENABLED === "true",
};
