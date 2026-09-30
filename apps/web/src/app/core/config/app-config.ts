/**
 * WARNING: NG_APP_* values ship in the bundle, readable in devtools — flags and
 * publishable keys only, never a secret. Each arrives as a STRING ("false" is
 * truthy), so parsing happens here once; no other file reads import.meta.env.
 */
export interface AppConfig {
  /** Whether the Stripe payment path is offered at checkout. */
  readonly stripeEnabled: boolean;
  /**
   * CONTRACT: The ONLY Stripe value allowed in the bundle — a publishable
   * `pk_...` key, never a secret or restricted one. Null leaves card entry off
   * even while `stripeEnabled` is true. See [[2026-09-19-stripe-payments-design]]
   */
  readonly stripePublishableKey: string | null;
  /**
   * CONTRACT: Stays RELATIVE ("/v1"). Nothing here sends CORS headers, so an
   * absolute gateway origin is blocked at the preflight; nginx and `ng serve`
   * proxy /v1 same-origin. See [[2026-09-04-web-gateway-integration-design]]
   */
  readonly apiGatewayUrl: string;
  /**
   * A FLAG, not the Geoapify key — that one is server-side only, appended by
   * nginx on the same-origin /geocode/ proxy. Off by default: an unconfigured
   * checkout shows a plain input, not one that 503s on every keystroke.
   */
  readonly geocodeEnabled: boolean;
  /**
   * CONTRACT: The HOST-facing `ws_url`, never `ws_management_endpoint` — that
   * one answers a browser handshake with an S3 XML body, not an endpoint error.
   * See [[2026-08-05-realtime-tracking-events-websocket-design]]
   */
  readonly wsUrl: string;
  /**
   * WHY: Off by default — the collector sits behind compose's `observability`
   * profile, so default-on spams failed exports on a plain `make up`.
   * See [[2026-09-19-web-rum-integration-design]]
   */
  readonly rumEnabled: boolean;
}

/**
 * CONTRACT: Nothing here throws, for any input — it runs at module scope, so
 * main.ts's `.catch` never fires and a throw strands the user on the boot loader.
 */
function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

const DEFAULT_API_GATEWAY_URL = '/v1';

export const MISSING_WS_URL_WARNING =
  'NG_APP_WS_URL is not set: realtime features (toast notifications, the live ' +
  'unread badge) are disabled and notifications arrive only on the next page load. ' +
  'Set NG_APP_WS_URL in apps/web/.env, mirroring WS_URL from .env.local.web.';

export const SECRET_STRIPE_KEY_WARNING =
  'NG_APP_STRIPE_PUBLISHABLE_KEY holds a SECRET Stripe key and has been discarded: ' +
  'card entry stays off. Only a publishable pk_ key may go in an NG_APP_* variable — ' +
  'it is compiled into the bundle and readable in devtools. Put the secret key in ' +
  'STRIPE_SECRET_KEY in .env.local.users / .env.local.orders instead, and ROTATE the ' +
  'key you just exposed.';

/**
 * CONTRACT: The variable NAME is legitimate, so no prefix filter can catch this —
 * only the VALUE distinguishes a publishable key from a secret one. A leaked
 * `sk_`/`rk_` is live credentials in a public bundle, so it is discarded rather
 * than shipped. See [[2026-09-29-web-env-consolidation-design]]
 */
function isSecretStripeKey(value: string): boolean {
  return /^(sk|rk)_/.test(value) || value.startsWith('whsec_');
}

export function parseAppConfig(
  env: unknown,
  warn: (message: string) => void = console.warn,
): AppConfig {
  const wsUrl = readString(env, 'NG_APP_WS_URL') ?? '';
  // CONTRACT: An unset socket URL stays a valid "realtime off" state and must
  // NOT throw — but it warns. Silence here is the bug it fixes: the socket never
  // opens, nothing is logged, and the whole realtime feature is simply absent.
  if (wsUrl === '') warn(MISSING_WS_URL_WARNING);

  // CONTRACT: An EMPTY string means unset — `make env-file` seeds the CUSTOM-box
  // entry with no value, and `loadStripe("")` rejects with an opaque error rather
  // than degrading. A SECRET key is dropped to null and warned about, never
  // passed through. See [[env-files]]
  let publishableKey = readString(env, 'NG_APP_STRIPE_PUBLISHABLE_KEY') || null;
  if (publishableKey !== null && isSecretStripeKey(publishableKey)) {
    warn(SECRET_STRIPE_KEY_WARNING);
    publishableKey = null;
  }

  return {
    stripeEnabled: readString(env, 'NG_APP_STRIPE_ENABLED') === 'true',
    stripePublishableKey: publishableKey,
    apiGatewayUrl: readString(env, 'NG_APP_API_GATEWAY_URL') || DEFAULT_API_GATEWAY_URL,
    geocodeEnabled: readString(env, 'NG_APP_GEOCODE_ENABLED') === 'true',
    wsUrl,
    rumEnabled: readString(env, 'NG_APP_RUM_ENABLED') === 'true',
  };
}

/**
 * CONTRACT: Spell each variable out as a full `import.meta.env.NG_APP_*` access.
 * esbuild defines only those dotted expressions, so passing the bare object or
 * destructuring it ships a bundle reading `undefined` for every one.
 * See [[env-files]]
 */
export const APP_CONFIG: AppConfig = parseAppConfig({
  NG_APP_STRIPE_ENABLED: import.meta.env.NG_APP_STRIPE_ENABLED,
  NG_APP_STRIPE_PUBLISHABLE_KEY: import.meta.env.NG_APP_STRIPE_PUBLISHABLE_KEY,
  NG_APP_API_GATEWAY_URL: import.meta.env.NG_APP_API_GATEWAY_URL,
  NG_APP_GEOCODE_ENABLED: import.meta.env.NG_APP_GEOCODE_ENABLED,
  NG_APP_WS_URL: import.meta.env.NG_APP_WS_URL,
  NG_APP_RUM_ENABLED: import.meta.env.NG_APP_RUM_ENABLED,
});
