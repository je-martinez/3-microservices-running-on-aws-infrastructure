/**
 * Types for the build-time variables @ngx-env/builder inlines.
 * Only NG_APP_*-prefixed variables are exposed; everything here is PUBLIC.
 */

/**
 * CONTRACT: Every member stays optional — the builder defines only what `.env`
 * holds, so an unset variable compiles to `undefined`, not `""`. Typing one as
 * required `string` hides that from the compiler. `config/app-config.ts` is
 * what turns these into a total `AppConfig`.
 */
interface ImportMetaEnv {
  readonly NG_APP_STRIPE_ENABLED?: string;
  /** Relative base path ("/v1"), never an absolute gateway origin. */
  readonly NG_APP_API_GATEWAY_URL?: string;
  /** Flag only — the Geoapify key never reaches the bundle. */
  readonly NG_APP_GEOCODE_ENABLED?: string;
  /** Host-facing realtime socket URL; empty leaves the socket unopened. */
  readonly NG_APP_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
