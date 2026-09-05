/**
 * Types for the build-time variables @ngx-env/builder inlines.
 * Only NG_APP_*-prefixed variables are exposed; everything here is PUBLIC.
 */
interface ImportMetaEnv {
  readonly NG_APP_STRIPE_ENABLED: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
