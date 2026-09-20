/**
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
   * A FLAG, not the Geoapify key: the key is server-side only, appended by nginx
   * on the same-origin /geocode/ proxy. Off by default, so an unconfigured
   * checkout shows a plain input rather than one that 503s on every keystroke.
   */
  readonly geocodeEnabled: boolean;
  /**
   * CONTRACT: The HOST-facing `ws_url`, never the in-network
   * `ws_management_endpoint` — that one is the server's publish endpoint and
   * answers a browser handshake with an S3 XML body, not an endpoint error.
   * Empty disables the socket rather than dialling a bad URL on every boot.
   * See [[2026-08-05-realtime-tracking-events-websocket-design]]
   */
  readonly wsUrl: string;
  /**
   * WHY: Off by default — the collector sits behind compose's `observability`
   * profile, so default-on would spam failed exports on a plain `make up`.
   * See [[2026-09-19-web-rum-integration-design]]
   */
  readonly rumEnabled: boolean;
}

/**
 * CONTRACT: Nothing in this file throws, for any input — it runs at module scope,
 * before `bootstrapApplication`, so main.ts's `.catch` never fires and a throw
 * strands the user on the navy boot loader. Bad input degrades and warns.
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

/** WHY: Exported and pure so the spec feeds it an env object, with no module resets. */
export function parseAppConfig(
  env: unknown,
  warn: (message: string) => void = console.warn,
): AppConfig {
  const wsUrl = readString(env, 'NG_APP_WS_URL') ?? '';
  // CONTRACT: An unset socket URL stays a valid "realtime off" state and must
  // NOT throw — but it warns. Silence here is the bug it fixes: the socket never
  // opens, nothing is logged, and the whole realtime feature is simply absent.
  if (wsUrl === '') warn(MISSING_WS_URL_WARNING);

  return {
    stripeEnabled: readString(env, 'NG_APP_STRIPE_ENABLED') === 'true',
    apiGatewayUrl: readString(env, 'NG_APP_API_GATEWAY_URL') || DEFAULT_API_GATEWAY_URL,
    geocodeEnabled: readString(env, 'NG_APP_GEOCODE_ENABLED') === 'true',
    wsUrl,
    rumEnabled: readString(env, 'NG_APP_RUM_ENABLED') === 'true',
  };
}

/**
 * CONTRACT: Spell each variable out as a full `import.meta.env.NG_APP_*` access.
 * @ngx-env/builder defines only those dotted expressions in esbuild, never
 * `import.meta.env` itself, so passing the bare object or destructuring it
 * ships a bundle reading `undefined` for all four — silently on the fallbacks.
 */
export const APP_CONFIG: AppConfig = parseAppConfig({
  NG_APP_STRIPE_ENABLED: import.meta.env.NG_APP_STRIPE_ENABLED,
  NG_APP_API_GATEWAY_URL: import.meta.env.NG_APP_API_GATEWAY_URL,
  NG_APP_GEOCODE_ENABLED: import.meta.env.NG_APP_GEOCODE_ENABLED,
  NG_APP_WS_URL: import.meta.env.NG_APP_WS_URL,
  NG_APP_RUM_ENABLED: import.meta.env.NG_APP_RUM_ENABLED,
});
