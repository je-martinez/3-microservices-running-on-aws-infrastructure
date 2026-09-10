/**
 * Build-time configuration, inlined by @ngx-env/builder.
 * WARNING: NG_APP_* values ship in the bundle, readable in devtools — flags and
 * publishable keys only, never a secret. Each arrives as a STRING ("false" is
 * truthy), so parsing happens here once; no other file reads import.meta.env.
 */
export interface AppConfig {
  /** Whether the Stripe payment path is offered at checkout. */
  readonly stripeEnabled: boolean;
  /**
   * Base path for every gateway call. CONTRACT: this stays RELATIVE ("/v1").
   * Nothing in this repo sends CORS headers, so an absolute gateway origin is
   * blocked at the preflight; nginx and `ng serve` proxy /v1 same-origin
   * instead. See [[2026-09-04-web-gateway-integration-design]]
   */
  readonly apiGatewayUrl: string;
  /**
   * Whether the address autocomplete is offered. A FLAG, not the Geoapify key:
   * the key is server-side only, appended by nginx on the same-origin /geocode/
   * proxy. Off by default, so an unconfigured checkout shows a plain address
   * input instead of a field that 503s on every keystroke.
   */
  readonly geocodeEnabled: boolean;
}

export const APP_CONFIG: AppConfig = {
  stripeEnabled: import.meta.env.NG_APP_STRIPE_ENABLED === "true",
  apiGatewayUrl: import.meta.env.NG_APP_API_GATEWAY_URL || "/v1",
  geocodeEnabled: import.meta.env.NG_APP_GEOCODE_ENABLED === "true",
};
