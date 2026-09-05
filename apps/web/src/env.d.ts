/**
 * Types for the build-time variables @ngx-env/builder inlines.
 * Only NG_APP_*-prefixed variables are exposed; everything here is PUBLIC.
 */
interface ImportMetaEnv {
  readonly NG_APP_STRIPE_ENABLED: string;
  /** Relative base path ("/v1"), never an absolute gateway origin. */
  readonly NG_APP_API_GATEWAY_URL: string;
  /** Flag only — the Geoapify key never reaches the bundle. */
  readonly NG_APP_GEOCODE_ENABLED: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
